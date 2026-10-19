"""Select the SDK required to compile the pinned optional video engine."""
import glob
import os
import subprocess


def main():
    candidates = sorted(glob.glob('/Applications/Xcode*.app/Contents/Developer'), reverse=True)
    for path in candidates:
        env = dict(os.environ, DEVELOPER_DIR=path)
        result = subprocess.run(['xcrun', '--sdk', 'macosx', '--show-sdk-version'], env=env, text=True, capture_output=True)
        if result.returncode == 0 and int(result.stdout.strip().split('.')[0]) >= 26:
            if os.environ.get('GITHUB_ENV'):
                with open(os.environ['GITHUB_ENV'], 'a') as output:
                    output.write(f'DEVELOPER_DIR={path}\n')
            print('Selected SDK:', result.stdout.strip(), path)
            return
    raise SystemExit('This build requires an installed macOS 26 SDK or newer.')


if __name__ == '__main__':
    main()
