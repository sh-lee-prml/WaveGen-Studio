"""Export pinned official RE-USE with one native CUDA SelectiveScan operator.

Original NVIDIA modules and the official Mamba class/reference scan are read
unchanged. Python/Torch are build-time tools, never runtime dependencies.
"""
from __future__ import annotations
import argparse
import ast
from datetime import datetime,timezone
import hashlib
import json
import os
import math
from pathlib import Path
import shutil
import sys
import time
import types
from typing import Optional

import numpy as np
import torch
from torch import nn,Tensor
from torch.nn import functional as F
from einops import rearrange,repeat
from safetensors.torch import load_file

HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[2]
SOURCE=Path(os.environ.get("REUSE_SOURCES", ROOT/"upstream/reuse")).resolve()
OFFICIAL=SOURCE/"official"
MAMBA=SOURCE/"mamba_source/mamba_ssm"
REVISION="31f82f2efad1095034492f236e8dac9239ba713b"
WEIGHT_SHA="06badaf4029b297f97f7fe48d62990b48d5482608210df577354e0d4e0ed70e1"
sys.path.insert(0,str(OFFICIAL))
if hasattr(sys.stdout,"reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8",errors="replace")
    sys.stderr.reconfigure(encoding="utf-8",errors="replace")

def sha256(path):
    digest=hashlib.sha256()
    with Path(path).open("rb") as f:
        for data in iter(lambda:f.read(1024*1024),b""):digest.update(data)
    return digest.hexdigest()

def write_json(path,data):
    Path(path).write_text(json.dumps(data,indent=2,ensure_ascii=False)+"\n",encoding="utf-8")

def load_definition(path,name,namespace):
    source=Path(path).read_text(encoding="utf-8")
    definition=next(n for n in ast.parse(source).body if isinstance(n,(ast.ClassDef,ast.FunctionDef)) and n.name==name)
    exec(compile(ast.Module(body=[definition],type_ignores=[]),str(path),"exec"),namespace)
    return namespace[name]

namespace=dict(torch=torch,F=F,rearrange=rearrange,repeat=repeat)
selective_scan_ref=load_definition(MAMBA/"ops/selective_scan_interface.py","selective_scan_ref",namespace)

class NativeSelectiveScan(torch.autograd.Function):
    @staticmethod
    def forward(ctx,u,delta,A,B,C,D,z,bias):
        if torch.onnx.is_in_onnx_export():
            # Shape-only tracing. The graph's actual evaluation is exclusively
            # the explicit custom operator below, verified against scan_ref.
            return u.clone()
        return selective_scan_ref(u,delta,A,B,C,D,z,bias,True)
    @staticmethod
    def symbolic(g,u,delta,A,B,C,D,z,bias):
        return g.op("wavegen.reuse::SelectiveScan",u,delta,A,B,C,D,z,bias).setType(u.type())

def scan(u,delta,A,B,C,D=None,z=None,delta_bias=None,delta_softplus=False,return_last_state=False):
    assert delta_softplus and not return_last_state and D is not None and z is not None and delta_bias is not None
    return NativeSelectiveScan.apply(u,delta,A,B,C,D,z,delta_bias)

def load_model(device="cpu"):
    global namespace
    namespace=dict(torch=torch,nn=nn,F=F,Tensor=Tensor,Optional=Optional,math=math,rearrange=rearrange,repeat=repeat,
                   selective_scan_fn=scan,causal_conv1d_fn=None,causal_conv1d_update=None,selective_state_update=None,
                   mamba_inner_fn=None,RMSNorm=None,layer_norm_fn=None,rms_norm_fn=None)
    Mamba=load_definition(MAMBA/"modules/mamba_simple.py","Mamba",namespace)
    module=types.ModuleType("mamba_ssm");module.Mamba=Mamba;sys.modules["mamba_ssm"]=module
    from models.generator_SEMamba_time_d4 import SEMamba
    cfg=json.loads((OFFICIAL/"config.json").read_text())
    model=SEMamba(cfg)
    model.load_state_dict(load_file(OFFICIAL/"model.safetensors",device="cpu"),strict=True)
    return model.eval().to(device),cfg

class ExportModel(nn.Module):
    def __init__(self,model):super().__init__();self.model=model
    def forward(self,noisy_mag,noisy_pha):
        mag,phase,_=self.model(noisy_mag,noisy_pha)
        return mag,phase

def dump(folder,name,tensor):
    value=tensor.detach().cpu().contiguous().float().numpy()
    path=folder/(name+".f32");value.astype("<f4").tofile(path)
    return dict(file=path.name,shape=list(value.shape),bytes=path.stat().st_size,sha256=sha256(path))

def scan_fixtures(output):
    inputs=("u","delta","A","B","C","D","z","dt_bias")
    records=[]
    for batch,channels,length in ((2,256,129),(3,256,17),(1,256,513)):
        folder=output/f"scan_b{batch}_l{length}";folder.mkdir(exist_ok=True)
        generator=torch.Generator().manual_seed(321+length)
        normal=lambda shape:torch.randn(shape,generator=generator)
        args=(normal((batch,channels,length))*.3,normal((batch,channels,length))*.7,
              -torch.exp(normal((channels,16))*.3),normal((batch,16,length))*.2,normal((batch,16,length))*.2,
              normal((channels,))*.2,normal((batch,channels,length)),normal((channels,))-2)
        with torch.inference_mode():want=selective_scan_ref(*args[:6],z=args[6],delta_bias=args[7],delta_softplus=True)
        record=dict(batch=batch,channels=channels,length=length,inputs={name:dump(folder,name,value) for name,value in zip(inputs,args)},output=dump(folder,"y",want))
        write_json(folder/"fixture.json",record);records.append(record)
    return records

def make_even(value):
    value=int(round(value));return value if value%2==0 else value+1

def audio_fixture(model,cfg,output,path,*,name="licensed_reference",seconds=2.0,sample_rate=24000):
    import soundfile as sf
    from scipy.signal import resample_poly
    from models.stfts import mag_phase_stft,mag_phase_istft
    source,rate=sf.read(path,dtype="float32")
    if source.ndim==2:source=source.mean(axis=1)
    if sample_rate!=rate:
        common=math.gcd(rate,sample_rate)
        source=resample_poly(source,sample_rate//common,rate//common).astype(np.float32)
    if seconds>0:source=source[:round(seconds*sample_rate)]
    folder=output/name;folder.mkdir(exist_ok=True)
    nfft=make_even(320*sample_rate//8000);hop=make_even(40*sample_rate//8000)
    tensor=torch.from_numpy(source).reshape(1,-1).to(next(model.parameters()).device)
    torch.cuda.synchronize() if tensor.is_cuda else None
    started=time.perf_counter()
    with torch.inference_mode():
        mag,phase,_=mag_phase_stft(tensor,nfft,hop,nfft,compress_factor="relu_log1p",addeps=False)
        amp,pha,_=model(mag,phase)
        rawamp=amp.clone()
        zero_portion=(torch.expm1(F.relu(amp))==0).float().mean(dim=1)
        amp[:,:,zero_portion[0]>.5]=0
        wave=mag_phase_istft(amp,pha,nfft,hop,nfft,compress_factor="relu_log1p")
        if wave.shape[1]<tensor.shape[1]:wave=F.pad(wave,(0,tensor.shape[1]-wave.shape[1]),value=1e-8)
        else:wave=wave[:,:tensor.shape[1]]
    torch.cuda.synchronize() if tensor.is_cuda else None
    elapsed=time.perf_counter()-started
    assets={k:dump(folder,k,v) for k,v in dict(input_audio=tensor,noisy_mag=mag,noisy_pha=phase,raw_amp=rawamp,enhanced_amp=amp,enhanced_pha=pha,enhanced_audio=wave).items()}
    sf.write(folder/"input.wav",source,sample_rate,subtype="PCM_16")
    sf.write(folder/"reference_enhanced.wav",wave.detach().cpu().numpy()[0],sample_rate,subtype="PCM_16")
    record=dict(name=name,source=str(path),source_sha256=sha256(path),sample_rate=sample_rate,n_fft=nfft,hop=hop,
                samples=len(source),seconds=elapsed,backend="Unmodified NVIDIA model modules + official Mamba2.2.4 class/nonfused selective_scan_ref FP32",assets=assets)
    write_json(folder/"fixture.json",record);print("Audio fixture",name,elapsed,flush=True)
    return record

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--output",type=Path,default=HERE/"artifacts")
    p.add_argument("--device",default="cuda")
    p.add_argument("--skip-export",action="store_true")
    p.add_argument("--audio-fixture",action="store_true")
    p.add_argument("--reference-audio",type=Path,default=ROOT/"presets/audio/mira.wav")
    p.add_argument("--seconds",type=float,default=2.0)
    args=p.parse_args();args.output.mkdir(parents=True,exist_ok=True)
    if sha256(OFFICIAL/"model.safetensors")!=WEIGHT_SHA:raise RuntimeError("Pinned checkpoint hash mismatch")
    torch.set_num_threads(4)
    if torch.cuda.is_available():
        torch.backends.cuda.matmul.allow_tf32=False;torch.backends.cudnn.allow_tf32=False
    started=time.perf_counter()
    records=scan_fixtures(args.output)
    model,cfg=load_model(args.device)
    count=sum(p.numel() for p in model.parameters())
    contract=dict(model_id="nemotron_reuse",hub_model_id="nvidia/NVIDIA-NemotronLabs-RE-USE",source_revision=REVISION,
        checkpoint_sha256=WEIGHT_SHA,parameters=count,precision="FP32",batch=1,
        inputs={"noisy_mag":[1,"frequency","time"],"noisy_pha":[1,"frequency","time"]},
        outputs={"enhanced_mag":[1,"frequency","time"],"enhanced_pha":[1,"frequency","time"]},
        mamba=dict(layers=30,scans=120,d_model=64,inner_dim=256,d_state=16,d_conv=4,dt_rank=4,
                   source_revision="95d8aba8a8c75aedcaa6143713b11e745e7cd0d9",custom_domain="wavegen.reuse",custom_op="SelectiveScan",custom_version=1),
        frontend=dict(sample_rate_min=8000,sample_rate_max=48000,rate_preserved=True,n_fft="make_even(320*sample_rate//8000)",
            hop="make_even(40*sample_rate//8000)",window="periodic Hann FP32",center=True,pad_mode="reflect",normalized=False,
            magnitude="log1p(abs(STFT))",phase="angle(STFT)",output_magnitude="expm1(relu(amp))",rms_normalization=False,
            sweep_suppression="zero whole frame when >50% bins output zero magnitude",istft="same Hann, normalized overlap-add, center trim",
            final_length="pad/truncate exact input length; pad1e-8",real_fft_boundary_phase="DC and Nyquist imaginary parts are exact positive zero, matching cuFFT R2C"),
        safeguards=dict(exact_zero_input="Return unchanged exact zeros without network inference; silence_bypass=true, completed request counted, cancellation/progress preserved. No amplitude threshold is applied to quiet nonzero input.",minimum_samples="strictly greater than n_fft/2, required for reflect padding",maximum_seconds=600),
        chunking=dict(seconds=5.0,hop_portion=.5,window="periodic Hann clamped min1e-7",last_chunk="right-aligned to input end",blend="weighted sum divided by window sum"),
        license="OpenMDW-1.1",scan_fixtures=records)
    if not args.skip_export:
        print("Exporting official model with120native SelectiveScan ops...",flush=True)
        # No real recurrence is needed during tracing: symbolic custom operators
        # preserve all eight inputs and the full dynamic output layout.
        example=(torch.rand((1,161,12),device=args.device),torch.rand((1,161,12),device=args.device))
        with torch.inference_mode():
            torch.onnx.export(ExportModel(model),example,str(args.output/"reuse.onnx"),
                input_names=["noisy_mag","noisy_pha"],output_names=["enhanced_mag","enhanced_pha"],
                dynamic_axes={k:{1:"frequency",2:"time"} for k in ("noisy_mag","noisy_pha","enhanced_mag","enhanced_pha")},
                opset_version=18,custom_opsets={"wavegen.reuse":1},dynamo=False,do_constant_folding=True)
        import onnx
        graph=onnx.load(str(args.output/"reuse.onnx"))
        countscan=sum(n.domain=="wavegen.reuse" and n.op_type=="SelectiveScan" for n in graph.graph.node)
        assert countscan==120,countscan
        onnx.helper.set_model_props(graph,{"model_id":"nemotron_reuse","precision":"FP32","source_revision":REVISION,"checkpoint_sha256":WEIGHT_SHA,"selective_scans":"120"})
        onnx.save_model(graph,str(args.output/"reuse.onnx"));onnx.checker.check_model(str(args.output/"reuse.onnx"))
        contract["onnx"]=dict(file="reuse.onnx",sha256=sha256(args.output/"reuse.onnx"),bytes=(args.output/"reuse.onnx").stat().st_size,
                               nodes=len(graph.graph.node),opsets={o.domain:o.version for o in graph.opset_import})
    if args.audio_fixture:
        contract["audio_fixture"]=audio_fixture(model,cfg,args.output,args.reference_audio,seconds=args.seconds)
    if args.skip_export and (args.output/"reuse.onnx").exists():
        import onnx
        graph=onnx.load(str(args.output/"reuse.onnx"))
        contract["onnx"]=dict(file="reuse.onnx",sha256=sha256(args.output/"reuse.onnx"),bytes=(args.output/"reuse.onnx").stat().st_size,
                               nodes=len(graph.graph.node),opsets={o.domain:o.version for o in graph.opset_import})
    shutil.copyfile(OFFICIAL/"LICENSE",args.output/"LICENSE-OpenMDW-1.1.txt")
    shutil.copyfile(SOURCE/"mamba_source/LICENSE",args.output/"LICENSE-Mamba-Apache-2.0.txt")
    contract["elapsed_seconds"]=time.perf_counter()-started
    write_json(args.output/"reuse_contract.json",contract)
    print("Done",contract["elapsed_seconds"],"parameters",count,flush=True)

if __name__=="__main__":main()
