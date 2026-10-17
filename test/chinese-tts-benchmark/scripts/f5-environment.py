import argparse
import json
import os
import platform
from pathlib import Path

parser=argparse.ArgumentParser()
parser.add_argument('--output',type=Path,required=True)
args=parser.parse_args()
args.output.mkdir(parents=True,exist_ok=True)
def read(path):
    try: return Path(path).read_text().strip()
    except OSError: return None
cpu=read('/proc/cpuinfo') or ''
data={'platform':platform.platform(),'machine':platform.machine(),'python':platform.python_version(),
    'cpuModel':next((line.split(':',1)[1].strip() for line in cpu.splitlines() if line.startswith('model name')),platform.processor()),
    'visibleLogicalCpus':os.cpu_count(),'memoryMax':read('/sys/fs/cgroup/memory.max'),
    'cpuMax':read('/sys/fs/cgroup/cpu.max'),'memoryInfo':read('/proc/meminfo'),
    'githubRunId':os.environ.get('GITHUB_RUN_ID'),'githubCommit':os.environ.get('GITHUB_SHA'),
    'runnerOs':os.environ.get('RUNNER_OS'),'runnerArch':os.environ.get('RUNNER_ARCH')}
(args.output/'hardware.json').write_text(json.dumps(data,indent=2))
print(json.dumps(data,indent=2))
