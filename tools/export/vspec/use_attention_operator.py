"""Diagnostic ONNX23 Attention variant for fused CUDA attention kernels."""
import argparse
import re
from pathlib import Path
import onnx
from onnx import helper,TensorProto

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument("model",type=Path)
args=parser.parse_args()
model=onnx.load(str(args.model),load_external_data=False)
groups={}
for node in model.graph.node:
    fx=next((p.value for p in node.metadata_props if p.key=="pkg.torch.onnx.fx_node"),"")
    if "aten.scaled_dot_product_attention.default" in fx:
        groups.setdefault(fx,[]).append(node)
removed=set();replacement={}
for index,(fx,nodes) in enumerate(groups.items()):
    match=re.search(r"args = \(%([^,]+), %([^,]+), %([^\)]+)\)",fx)
    assert match,fx
    q,k,v=match.groups()
    output=fx.split(" : ",1)[0][1:]
    prefix=f"sdpa_opmath_{index}"
    replacement[prefix+"_cast_out"]=helper.make_node("Attention",[q,k,v],[output],name=f"fused_attention_{index}",softmax_precision=TensorProto.FLOAT,is_causal=0)
    removed.update(n.name for n in nodes)
    removed.update(n.name for n in model.graph.node if n.name.startswith(prefix+"_"))
nodes=[]
for node in model.graph.node:
    if node.name in replacement:
        nodes.append(replacement[node.name])
    elif node.name not in removed:
        nodes.append(node)
model.graph.ClearField("node");model.graph.node.extend(nodes)
for opset in model.opset_import:
    if opset.domain=="":opset.version=23
props={v.key:v.value for v in model.metadata_props};props["sdpa_operator"]="ONNX23Attention"
helper.set_model_props(model,props)
path=args.model.with_stem(args.model.stem+"_attention23")
onnx.save_model(model,str(path));onnx.checker.check_model(str(path),full_check=True)
print(path,"Attention operators",len(groups))
