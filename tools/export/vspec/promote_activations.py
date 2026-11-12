"""Restore fused PyTorch GELU/SiLU FP32 opmath in BF16 ONNX inference."""
import argparse
from collections import defaultdict
from pathlib import Path
import onnx
from onnx import helper, TensorProto

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("model",type=Path)
    args=p.parse_args()
    model=onnx.load(str(args.model),load_external_data=False)
    groups=defaultdict(list)
    for node in model.graph.node:
        fx=next((p.value for p in node.metadata_props if p.key=="pkg.torch.onnx.fx_node"),"")
        if "aten.gelu.default" in fx or "aten.silu.default" in fx:
            groups[fx].append(node)
    replacements={};removed=set()
    types={v.name:v.type.tensor_type.elem_type for v in model.graph.value_info}
    for index,(fx,nodes) in enumerate(groups.items()):
        final=nodes[-1]
        name=final.output[0]
        source=final.input[0]
        assert types[source]==TensorProto.BFLOAT16 and types[name]==TensorProto.BFLOAT16
        prefix=f"activation_opmath_{index}"
        replacement=[helper.make_node("Cast",[source],[prefix+"_in"],name=prefix+"_cast_in",to=TensorProto.FLOAT)]
        if "aten.gelu" in fx:
            replacement.append(helper.make_node("Gelu",[prefix+"_in"],[prefix+"_out"],name=prefix+"_gelu",approximate="tanh" if "approximate: tanh" in fx else "none"))
        else:
            replacement.extend([helper.make_node("Sigmoid",[prefix+"_in"],[prefix+"_sigmoid"],name=prefix+"_sigmoid"),
                                helper.make_node("Mul",[prefix+"_in",prefix+"_sigmoid"],[prefix+"_out"],name=prefix+"_mul")])
        replacement.append(helper.make_node("Cast",[prefix+"_out"],[name],name=prefix+"_cast_out",to=TensorProto.BFLOAT16))
        replacements[final.name]=replacement
        removed.update(n.name for n in nodes)
    nodes=[]
    for node in model.graph.node:
        if node.name in replacements:
            nodes.extend(replacements[node.name])
        elif node.name not in removed:
            nodes.append(node)
    model.graph.ClearField("node");model.graph.node.extend(nodes)
    path=args.model.with_stem(args.model.stem+"_activations")
    props={v.key:v.value for v in model.metadata_props};props["activation_opmath"]="FP32"
    helper.set_model_props(model,props)
    onnx.save_model(model,str(path));onnx.checker.check_model(str(path),full_check=True)
    print(path,"promoted activations",len(groups))

if __name__=="__main__":
    main()
