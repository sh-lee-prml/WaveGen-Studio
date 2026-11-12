"""Preserve PyTorch FP32 opmath inside fused BF16 SDPA and scalar division.

ONNX's primitive BF16 decomposition rounds attention scores/probabilities and
Python scalar divisors too early. Keep the public BF16 attention output.
"""
import argparse
import math
from pathlib import Path
import numpy as np
import onnx
from onnx import helper, numpy_helper, TensorProto

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("model", type=Path)
    p.add_argument("--dropout", action="store_true")
    p.add_argument("--no-attention", action="store_true")
    args=p.parse_args()
    model=onnx.load(str(args.model), load_external_data=False)
    producers={o:n for n in model.graph.node for o in n.output}
    infos={v.name:v for v in model.graph.value_info}
    before, after, removed={}, {}, set()
    count=0
    if not args.no_attention:
        for final in list(model.graph.node):
            if not final.name.startswith("node_scaled_dot_product_attention") or final.op_type!="MatMul":
                continue
            probability=producers[final.input[0]]
            score=producers[probability.input[0]]
            qscale,kscale=[producers[x] for x in score.input]
            assert probability.op_type=="Softmax" and score.op_type=="MatMul" and qscale.op_type==kscale.op_type=="Mul"
            q,k=qscale.input[0],kscale.input[0]
            width=infos[q].type.tensor_type.shape.dim[-1].dim_value
            assert width>0
            prefix=f"sdpa_opmath_{count}"
            qf,kf,vf=prefix+"_q",prefix+"_k",prefix+"_v"
            before[score.name]=[helper.make_node("Cast",[q],[qf],name=prefix+"_cast_q",to=TensorProto.FLOAT),
                                helper.make_node("Cast",[k],[kf],name=prefix+"_cast_k",to=TensorProto.FLOAT)]
            score.input[:]=[qf,kf]
            scale=prefix+"_scale"
            model.graph.initializer.append(numpy_helper.from_array(np.asarray(1/math.sqrt(width),dtype=np.float32),name=scale))
            scaled=prefix+"_scores"
            after[score.name]=[helper.make_node("Mul",[score.output[0],scale],[scaled],name=prefix+"_scale_scores")]
            probability.input[0]=scaled
            before[final.name]=[helper.make_node("Cast",[final.input[1]],[vf],name=prefix+"_cast_v",to=TensorProto.FLOAT)]
            final.input[1]=vf
            original=final.output[0]
            final.output[0]=prefix+"_result"
            after[final.name]=[helper.make_node("Cast",[final.output[0]],[original],name=prefix+"_cast_out",to=TensorProto.BFLOAT16)]
            for value in (score.output[0],probability.output[0]):
                infos[value].type.tensor_type.elem_type=TensorProto.FLOAT
            removed.update((qscale.name,kscale.name))
            count+=1
    divisions=0
    if args.dropout:
        for node in model.graph.node:
            if node.op_type!="Div" or list(node.input)[1:]!=["scalar_tensor_default_1"]:
                continue
            prefix=f"dropout_opmath_{divisions}"
            divisor=prefix+"_divisor"
            model.graph.initializer.append(numpy_helper.from_array(np.asarray(0.8,dtype=np.float32),name=divisor))
            before[node.name]=[helper.make_node("Cast",[node.input[0]],[prefix+"_value"],name=prefix+"_cast_in",to=TensorProto.FLOAT)]
            node.input[:]=[prefix+"_value",divisor]
            original=node.output[0]
            node.output[0]=prefix+"_result"
            after[node.name]=[helper.make_node("Cast",[node.output[0]],[original],name=prefix+"_cast_out",to=TensorProto.BFLOAT16)]
            divisions+=1
    nodes=[]
    for node in model.graph.node:
        if node.name in removed:
            continue
        nodes.extend(before.get(node.name,[]))
        nodes.append(node)
        nodes.extend(after.get(node.name,[]))
    model.graph.ClearField("node")
    model.graph.node.extend(nodes)
    suffix=("_opmath" if not args.no_attention else "")+("_dropout" if args.dropout else "")
    path=args.model.with_stem(args.model.stem+suffix)
    props={v.key:v.value for v in model.metadata_props}
    props.update(sdpa_opmath="FP32" if count else "unmodified", dropout_scalar_opmath="FP32" if divisions else "unmodified")
    helper.set_model_props(model,props)
    onnx.save_model(model,str(path))
    onnx.checker.check_model(str(path),full_check=True)
    print(path, "attention blocks",count,"dropout divisions",divisions)

if __name__=="__main__":
    main()
