"""Fold constant FP32->BF16 initializer casts without loading a >2GB protobuf.

Only weights whose every consumer is a Cast(BFLOAT16) are converted. Runtime
values remain those of the original cast; FP32 operators and weights stay FP32.
"""
from collections import defaultdict
import argparse
import json
from pathlib import Path
import shutil

import ml_dtypes
import numpy as np
import onnx


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=Path(__file__).parent / "artifacts_bf16")
    parser.add_argument("--destination", type=Path, default=Path(__file__).parent / "artifacts_bf16_compact")
    args = parser.parse_args()
    args.destination.mkdir(parents=True, exist_ok=True)
    model_path = args.source / "wavegen_flash_step.onnx"
    model = onnx.load(str(model_path), load_external_data=False)
    consumers = defaultdict(list)
    for node in model.graph.node:
        for name in node.input:
            consumers[name].append(node)
    converted = {
        value.name for value in model.graph.initializer
        if value.data_type == onnx.TensorProto.FLOAT and consumers[value.name]
        and all(node.op_type == "Cast" and next(a.i for a in node.attribute if a.name == "to") == onnx.TensorProto.BFLOAT16
                for node in consumers[value.name])
    }
    remap = {node.output[0]: name for name in converted for node in consumers[name]}
    nodes = []
    for node in model.graph.node:
        if node.op_type == "Cast" and node.input[0] in converted:
            continue
        for index, name in enumerate(node.input):
            node.input[index] = remap.get(name, name)
        nodes.append(node)
    del model.graph.node[:]
    model.graph.node.extend(nodes)
    output_data = args.destination / "wavegen_flash_step.onnx.data"
    with output_data.open("wb") as target:
        for tensor in model.graph.initializer:
            external = {entry.key: entry.value for entry in tensor.external_data}
            is_converted = tensor.name in converted
            if not external and not is_converted:
                continue
            padding = (-target.tell()) % 64
            if padding:
                target.write(b"\0" * padding)
            offset = target.tell()
            if external:
                source_path = args.source / external["location"]
                with source_path.open("rb") as source:
                    source.seek(int(external.get("offset", 0)))
                    remaining = int(external["length"])
                    if is_converted:
                        raw = source.read(remaining)
                        if len(raw) != remaining:
                            raise OSError(f"Truncated external tensor: {tensor.name}")
                        converted_array = np.frombuffer(raw, dtype="<f4").astype(ml_dtypes.bfloat16)
                        target.write(converted_array.tobytes())
                    else:
                        while remaining:
                            block = source.read(min(remaining, 8 * 1024 * 1024))
                            if not block:
                                raise OSError(f"Truncated external tensor: {tensor.name}")
                            target.write(block)
                            remaining -= len(block)
            else:
                array = onnx.numpy_helper.to_array(tensor).astype(ml_dtypes.bfloat16)
                target.write(array.tobytes())
            if is_converted:
                tensor.data_type = onnx.TensorProto.BFLOAT16
            length = target.tell() - offset
            tensor.ClearField("raw_data")
            tensor.ClearField("float_data")
            del tensor.external_data[:]
            tensor.data_location = onnx.TensorProto.EXTERNAL
            for key, value in dict(location=output_data.name, offset=str(offset), length=str(length)).items():
                entry = tensor.external_data.add()
                entry.key, entry.value = key, value
    metadata = {entry.key: entry.value for entry in model.metadata_props}
    metadata["constant_weight_casts_folded"] = str(len(converted))
    onnx.helper.set_model_props(model, metadata)
    initializer_types = {value.name: value.data_type for value in model.graph.initializer}
    for value in model.graph.value_info:
        if value.name in initializer_types:
            value.type.tensor_type.elem_type = initializer_types[value.name]
    # Conv-22 adds BF16 to the schema; exported op semantics otherwise agree.
    for opset in model.opset_import:
        if opset.domain == "":
            opset.version = max(opset.version, 22)
    output_model = args.destination / model_path.name
    onnx.save_model(model, str(output_model))
    onnx.checker.check_model(str(output_model), full_check=True)
    for filename in ("mel_filter.f32", "hann_window.f32", "vocab.txt", "model_contract.json"):
        if (args.source / filename).exists():
            shutil.copyfile(args.source / filename, args.destination / filename)
    result = dict(converted_initializers=len(converted), removed_casts=len(remap),
                  graph_bytes=output_model.stat().st_size, external_bytes=output_data.stat().st_size,
                  source=str(model_path), output=str(output_model))
    (args.destination / "compaction.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
