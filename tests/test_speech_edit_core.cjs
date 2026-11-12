'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const source=path.resolve(__dirname,'../web/speech-edit.js');
const context={window:{}};vm.createContext(context);vm.runInContext(fs.readFileSync(source,'utf8'),context);
const core=context.window.StudioSpeechEditCore,checks=[];
function mark(name){checks.push({name,passed:true});}
function wav(samples,{rate=24000,channels=1,float=false}={}){
 const stride=float?4:2,b=Buffer.alloc(44+samples.length*stride);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(float?3:1,20);b.writeUInt16LE(channels,22);b.writeUInt32LE(rate,24);b.writeUInt32LE(rate*stride*channels,28);b.writeUInt16LE(stride*channels,32);b.writeUInt16LE(stride*8,34);b.write('data',36);b.writeUInt32LE(samples.length*stride,40);
 samples.forEach((sample,i)=>float?b.writeFloatLE(sample,44+i*stride):b.writeInt16LE(sample,44+i*stride));return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);
}
const decoded=core.decodeWav(wav([-32768,-123,0,123,32767]));
assert.equal(decoded.sampleRate,24000);assert.equal(decoded.samples.length,5);assert.equal(decoded.duration,5/24000);
assert.deepEqual(Array.from(decoded.samples),[-1,-123/32768,0,123/32768,32767/32768]);mark('PCM16 waveform decoding retains the native sample clock and amplitudes');
const floats=core.decodeWav(wav([-.5,0,.5],{float:true}));assert.deepEqual(Array.from(floats.samples),[-.5,0,.5]);mark('Float WAV samples decode without resampling');
for(const bad of [wav([0],{rate:48000}),wav([0,0],{channels:2}),wav([Infinity],{float:true}),new ArrayBuffer(10)])assert.throws(()=>core.decodeWav(bad),error=>error.message==='edit.unsupported');
const truncated=wav([0,1]);new DataView(truncated).setUint32(40,999999,true);assert.throws(()=>core.decodeWav(truncated),error=>error.message==='edit.unsupported');mark('Malformed, unsupported, truncated and nonfinite WAV data are rejected');
assert.deepEqual(JSON.parse(JSON.stringify(core.sampleRange(.123125,4.123125,98955))),{first:2955,last:98955,seconds:4});
for(const pair of [[-1,1],[0,5],[1,1.099],[2,1],[NaN,1],[0,Infinity]])assert.equal(core.sampleRange(...pair,98955),null);
assert.equal(core.sampleRange(0,.1,2400).last,2400);mark('Region bounds are checked and converted to exact samples');
const values=core.peaks(new Float32Array([-.2,.4,-.8,.1,0,.9]),3);assert.equal(values.length,6);assert(Math.abs(values[2]+.8)<1e-7);assert(Math.abs(values[5]-.9)<1e-7);assert(core.peaks(new Float32Array([.5]),20).every(Number.isFinite));mark('Zoom envelopes retain quiet and loud waveform extrema');
let segments=core.segmentRanges({duration_seconds:3.12,segments:[{text:'One.',duration_seconds:1},{text:'Two.',duration_seconds:2}]});assert.equal(segments[1].start,1.12);assert.equal(segments[1].end,3.12);
assert.equal(core.segmentRanges({duration_seconds:3.12,transcript_stale:true,segments:[{text:'Old text',duration_seconds:3.12}]}).length,0);
assert.equal(core.segmentRanges({duration_seconds:5,segments:[{text:'Bad metadata',duration_seconds:3}]}).length,0);mark('Legacy section timing includes joins; stale or inconsistent transcript alignment is never offered');
const report={passed:checks.length,failed:0,source_sha256:crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex'),checks};
fs.writeFileSync(path.join(__dirname,'speech_edit_core_validation.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({passed:report.passed,failed:0}));
