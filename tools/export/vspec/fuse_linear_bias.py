"""Use fused Gemm for BF16 biased Linear to avoid premature MatMul rounding."""
import argparse
from pathlib import Path
import numpy as np
import onnx
from onnx import helper, numpy_helper, TensorProto

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("model",type=Path)
    args=parser.parse_args()
    model=onnx.load(str(args.model),load_external_data=False)
    producers={o:n for n in model.graph.node for o in n.output}
    infos={v.name:v for v in model.graph.value_info}
    users={}
    for n in model.graph.node:
        for value in n.input:
            users.setdefault(value,[]).append(n)
    replaced={};removed=set();count=0
    for node in model.graph.node:
        if node.op_type!="Add" or not node.name.startswith("node_linear"):
            continue
        matmul=producers.get(node.input[0])
        if matmul is None or matmul.op_type!="MatMul" or len(users[matmul.output[0]])!=1:
            continue
        source,weight=matmul.input
        info=infos[source].type.tensor_type
        if info.elem_type!=TensorProto.BFLOAT16:
            continue
        k=info.shape.dim[-1].dim_value
        n=infos[node.output[0]].type.tensor_type.shape.dim[-1].dim_value
        assert k>0 and n>0
        prefix=f"linear_fused_{count}"
        constants={"flat_shape":[-1,k],"start":[0],"end":[-1],"axis":[0],"last":[n]}
        for label,data in constants.items():
            model.graph.initializer.append(numpy_helper.from_array(np.asarray(data,dtype=np.int64),name=prefix+"_"+label))
        replaced[node.name]=[
            helper.make_node("Reshape",[source,prefix+"_flat_shape"],[prefix+"_flat"],name=prefix+"_flatten"),
            helper.make_node("Gemm",[prefix+"_flat",weight,node.input[1]],[prefix+"_linear"],name=prefix+"_gemm"),
            helper.make_node("Shape",[source],[prefix+"_shape"],name=prefix+"_shape"),
            helper.make_node("Slice",[prefix+"_shape",prefix+"_start",prefix+"_end",prefix+"_axis"],[prefix+"_leading"],name=prefix+"_leading"),
            helper.make_node("Concat",[prefix+"_leading",prefix+"_last"],[prefix+"_result_shape"],name=prefix+"_concat",axis=0),
            helper.make_node("Reshape",[prefix+"_linear",prefix+"_result_shape"],list(node.output),name=prefix+"_restore")]
        removed.add(matmul.name);count+=1
    nodes=[]
    for node in model.graph.node:
        if node.name in replaced:
            nodes.extend(replaced[node.name])
        elif node.name not in removed:
            nodes.append(node)
    model.graph.ClearField("node");model.graph.node.extend(nodes)
    props={v.key:v.value for v in model.metadata_props};props["biased_linear_math"]="fused_BF16_Gemm"
    helper.set_model_props(model,props)
    path=args.model.with_stem(args.model.stem+"_gemm")
    onnx.save_model(model,str(path));onnx.checker.check_model(str(path),full_check=True)
    print(path,"fused linear layers",count)

if __name__=="__main__":
    main()
