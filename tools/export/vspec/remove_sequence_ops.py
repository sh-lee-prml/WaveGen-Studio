"""Replace static channel chunks with ONNX Split and eliminate zero padding.

Only rewrites proven constant cases. Dynamic waveform-frame dimensions remain
dynamic. External weight references are preserved without copying large files.
"""
from collections import defaultdict
import argparse
from pathlib import Path
import numpy as np
import onnx


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("model", type=Path)
    args = parser.parse_args()
    model = onnx.load(str(args.model), load_external_data=False)
    constants = {}
    for value in model.graph.initializer:
        if not value.external_data:
            constants[value.name] = onnx.numpy_helper.to_array(value)
    for node in model.graph.node:
        if node.op_type == "Constant":
            for attr in node.attribute:
                if attr.name == "value":
                    constants[node.output[0]] = onnx.numpy_helper.to_array(attr.t)
    users = defaultdict(list)
    for node in model.graph.node:
        for value in node.input:
            users[value].append(node)
    shapes = {
        value.name: [dimension.dim_value for dimension in value.type.tensor_type.shape.dim]
        for value in model.graph.value_info if value.type.HasField("tensor_type")
    }
    skip_names = set()
    remove_values = set()
    replacements = {}
    aliases = {}
    split_count = 0
    pad_count = 0
    for node in model.graph.node:
        if node.op_type == "Pad" and node.input[1] in constants and np.all(constants[node.input[1]] == 0):
            aliases[node.output[0]] = node.input[0]
            skip_names.add(node.name)
            remove_values.add(node.output[0])
            pad_count += 1
        if node.op_type != "SplitToSequence":
            continue
        attributes = {attr.name: attr.i for attr in node.attribute}
        if attributes.get("keepdims", 1) != 1:
            raise RuntimeError("Refusing non-keepdims sequence split")
        consumers = users[node.output[0]]
        if not consumers or any(consumer.op_type != "SequenceAt" for consumer in consumers):
            raise RuntimeError("Sequence split has unexpected users")
        by_index = {}
        for consumer in consumers:
            if consumer.input[1] not in constants:
                raise RuntimeError("SequenceAt index is not constant")
            index = int(constants[consumer.input[1]])
            if index in by_index:
                raise RuntimeError("Duplicate SequenceAt index")
            by_index[index] = consumer.output[0]
        if sorted(by_index) != list(range(len(consumers))):
            raise RuntimeError("SequenceAt outputs do not cover the complete split")
        scalar = constants.get(node.input[1])
        if scalar is None or np.asarray(scalar).size != 1:
            raise RuntimeError("Expected a constant scalar chunk width")
        width = int(np.asarray(scalar).reshape(()))
        axis = attributes.get("axis", 0)
        if node.input[0] not in shapes or shapes[node.input[0]][axis] != width * len(consumers):
            raise RuntimeError("Static dimension does not prove an evenly divisible channel split")
        sizes_name = node.output[0] + "_static_sizes"
        model.graph.initializer.append(onnx.numpy_helper.from_array(
            np.full(len(consumers), width, dtype=np.int64), sizes_name))
        replacements[node.name] = onnx.helper.make_node(
            "Split", [node.input[0], sizes_name], [by_index[i] for i in range(len(consumers))],
            name=node.name + "_static", axis=axis,
        )
        skip_names.update(consumer.name for consumer in consumers)
        remove_values.add(node.output[0])
        split_count += 1
    def resolve(name):
        while name in aliases:
            name = aliases[name]
        return name
    rewritten = []
    for node in model.graph.node:
        if node.name in skip_names:
            continue
        node = replacements.get(node.name, node)
        for index, value in enumerate(node.input):
            node.input[index] = resolve(value)
        rewritten.append(node)
    del model.graph.node[:]
    model.graph.node.extend(rewritten)
    info = [value for value in model.graph.value_info if value.name not in remove_values]
    del model.graph.value_info[:]
    model.graph.value_info.extend(info)
    props = {entry.key: entry.value for entry in model.metadata_props}
    props.update(static_channel_splits=str(split_count), zero_pads_removed=str(pad_count))
    onnx.helper.set_model_props(model, props)
    target = args.model.with_name(args.model.stem + "_optimized.onnx")
    onnx.save_model(model, str(target))
    onnx.checker.check_model(str(target), full_check=True)
    print(f"Wrote {target}; static Split replacements={split_count}, zero Pads removed={pad_count}")


if __name__ == "__main__":
    main()
