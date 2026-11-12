"""Manual GPU release check. Run against a fresh, disposable Studio install.

Creates two generated recordings and one enhanced copy, without editing voices.
Python is used only by this test driver, never by the application runtime.
"""
from http.cookiejar import CookieJar
from pathlib import Path
import argparse
import hashlib
import io
import json
import urllib.parse
import urllib.request
import uuid
import wave

TEXT = 'Welcome to WaveGen Studio. Choose a voice, write your words, and bring your next idea to life.'


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url',required=True,help='Separate local test instance, for example http://127.0.0.1:8775')
    parser.add_argument('--report',type=Path,default=Path('test-output/gpu-smoke.json'))
    args=parser.parse_args()
    address=urllib.parse.urlsplit(args.url)
    assert address.scheme=='http' and address.hostname in {'127.0.0.1','localhost','::1'} and not address.username
    base=args.url.rstrip('/')
    opener=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))
    with opener.open(base+'/',timeout=20) as response:assert response.status==200

    def request(path,body=None):
        headers={'X-WaveGen-Client':'studio'}
        data=None if body is None else json.dumps(body).encode()
        if data is not None:headers['Content-Type']='application/json'
        with opener.open(urllib.request.Request(base+path,data=data,headers=headers),timeout=180) as response:
            raw=response.read()
            return json.loads(raw) if 'json' in response.headers.get('Content-Type','') else raw

    def audio_info(item):
        raw=request(item['audio_url'])
        with wave.open(io.BytesIO(raw),'rb') as wav:
            assert (wav.getframerate(),wav.getnchannels(),wav.getsampwidth())==(24000,1,2)
            assert wav.getnframes()==item['samples']>0
            frames=wav.readframes(wav.getnframes())
            assert any(frames)
        return {'id':item['id'],'sha256':hashlib.sha256(raw).hexdigest(),'samples':item['samples'],
                'model_id':item.get('model_id'),'enhanced':item.get('enhanced',False)}

    initial=request('/api/status')
    version=json.loads((Path(__file__).resolve().parents[1]/'version.json').read_text())['version']
    assert initial['state']=='ready' and initial['version']==version and initial['generation_count']==0,'Use a fresh disposable test instance'
    library=request('/api/voices')
    assert not library.get('warnings') and {v['name'] for v in library['voices']}=={'Mira','Rowan','Kai'}
    assert len(library['voices'])==3 and all(not v.get('character_effect') and not v.get('builtin') for v in library['voices'])
    voice=next(v for v in library['voices'] if v['name']=='Mira')
    report={'passed':False,'version':version,'voices':['Mira','Rowan','Kai'],'text':TEXT,'cases':[],
            'subjective_listening_performed':False}
    for model in ['flash','vspec']:
        payload={'voice_id':voice['id'],'model_id':model,'text':TEXT,'seed':23,'speed':1,
                 'duration_seconds':0,'split_long_text':True,'enhance_output':False,'request_id':uuid.uuid4().hex}
        plan=request('/api/plan',payload)
        result=request('/api/generate',payload)
        assert result['model_id']==model and result['samples']==plan['samples']
        assert not result.get('character_effect') and not result.get('enhanced')
        row=audio_info(result);report['cases'].append(row)
        print(json.dumps(row),flush=True)
    enhanced=request('/api/enhance',{'source_id':result['id'],'request_id':uuid.uuid4().hex})
    assert enhanced['enhanced'] and enhanced['samples']==result['samples']
    row=audio_info(enhanced);report['cases'].append(row);print(json.dumps(row),flush=True)
    final=request('/api/status')
    assert final['state']=='ready' and final['instance_id']==initial['instance_id']
    assert all(model['loaded'] and model['load_count']==1 for model in final['models'])
    assert final['enhancement']['loaded'] and final['enhancement']['load_count']==1
    assert request('/api/voices')==library,'Saved profiles changed during inference'
    report.update(passed=True,models_loaded_once=True,enhancement_loaded_once=True)
    args.report.parent.mkdir(parents=True,exist_ok=True)
    args.report.write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')
    print('Passed: fresh public library, Flash, V-Spec, RE-USE, resident sessions, unchanged profiles.')


if __name__=='__main__':main()
