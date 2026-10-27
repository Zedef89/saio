import os,subprocess,time,json,re,sys,shlex,hashlib,fcntl
from pathlib import Path
from datetime import datetime, timezone, timedelta
config=Path(sys.argv[1]).resolve();dest=config/'saio-usage-local.json';cwd=Path('/tmp/saio-native-quota-check');cwd.mkdir(exist_ok=True)
name='__saio-quota-'+hashlib.sha256(str(config).encode()).hexdigest()[:12]
lock=open(config/'.saio-quota-read.lock','a')
try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
except BlockingIOError:
 print(json.dumps({'result':'busy'}));sys.exit(0)
def tm(*args):return subprocess.run(['tmux',*args],text=True,capture_output=True,check=True).stdout
def retry_at(screen):
 match=re.search(r'rate limited until (\d{1,2}):(\d{2})(am|pm)',screen)
 if not match:return None
 now=datetime.now(timezone.utc); h=int(match[1])%12+(12 if match[3]=='pm' else 0)
 until=now.replace(hour=h,minute=int(match[2]),second=0,microsecond=0)
 if until<=now:until+=timedelta(days=1)
 return int(until.timestamp()*1000)
start=time.time();tm('new-session','-d','-s',name,'-x','110','-y','45','-c',str(cwd),'env CLAUDE_CONFIG_DIR='+shlex.quote(str(config))+' DISABLE_AUTOUPDATER=1 /usr/bin/claude /usage')
trusted=False;escaped=False;usage_at=None;screen=''
try:
 while time.time()-start<25:
  time.sleep(.5)
  try:screen=tm('capture-pane','-p','-t','='+name+':')
  except subprocess.CalledProcessError:break
  if not trusted and 'Yes, I trust this folder' in screen:
   tm('send-keys','-t','='+name+':','Down','Enter');trusted=True;continue
  if 'Error: Usage endpoint is rate limited' in screen:break
  if usage_at is None and ('Current week' in screen or 'Current session' in screen) and re.search(r'\d+% used',screen):usage_at=time.time()
  if usage_at and not escaped and time.time()-usage_at>2:
   tm('send-keys','-t','='+name+':','Escape');escaped=True
  if escaped and dest.exists():
   d=json.loads(dest.read_text())
   if d.get('at',0)/1000>=start:
    print(json.dumps({'config':config.name,'result':'ok','usage':d['usage']}),flush=True);break
 if not dest.exists() or json.loads(dest.read_text()).get('at',0)/1000<start:
  print(json.dumps({'config':config.name,'result':'no-fresh-telemetry','windows':re.findall(r'(?:Current session|Current week[^\n]*|\d+% used|rate limited[^\n]*)',screen)[-8:], 'retryAt':retry_at(screen)}),flush=True)
finally:
 try:tm('kill-session','-t','='+name)
 except subprocess.CalledProcessError:pass
