import re
import subprocess
import sys
import time

from smoke import PACKAGE, OUTPUT, adb, shell, click, resumed, open_launcher_entry, wait_for


def package_state():
    return shell('dumpsys', 'package', PACKAGE)


def wait_for_authorization():
    for _ in range(110):
        if resumed('com.android.settings'):
            return
        time.sleep(1)
    raise AssertionError('Downloading the official APK did not open the unknown-app permission page')


def installer_resumed():
    return bool(re.search(ref, shell('dumpsys', 'activity', 'activities'), flags=re.I | re.M))


ref = r'(?:topResumedActivity=|mResumedActivity:)[^\n]*(?:packageinstaller|/[^\s]*InstallStart|/[^\s]*PackageInstallerActivity)'


def main(apk):
    shell('wm', 'size', '1080x2160')
    shell('wm', 'density', '420')
    shell('input', 'keyevent', 'KEYCODE_WAKEUP')
    shell('wm', 'dismiss-keyguard')
    print(adb('install', apk), flush=True)
    before = package_state()
    assert 'versionName=0.5.999' in before
    install_time = re.search(r'firstInstallTime=([^\n]+)', before)
    assert install_time is not None
    open_launcher_entry()
    click('设置')
    click('检查更新')
    wait_for_authorization()
    print('PASS clicked in-app update and downloaded the signed public APK', flush=True)
    shell('appops', 'set', PACKAGE, 'REQUEST_INSTALL_PACKAGES', 'allow')
    shell('input', 'keyevent', 'KEYCODE_BACK')
    wait_for(installer_resumed, bool, 'Returning after authorization did not open Android Package Installer')
    with (OUTPUT / 'installer.png').open('wb') as image:
        subprocess.run(['adb', 'exec-out', 'screencap', '-p'], stdout=image, timeout=15)
    click('Update')
    after = wait_for(package_state, lambda state: 'versionName=0.6.0' in state, 'System installer did not update to 0.6.0')
    assert re.search(r'firstInstallTime=([^\n]+)', after).group(1) == install_time.group(1)
    print('PASS installer opened automatically, accepted the signed upgrade and preserved the installed app', flush=True)


if __name__ == '__main__':
    OUTPUT.mkdir(exist_ok=True)
    try:
        main(sys.argv[1])
    finally:
        (OUTPUT / 'crash.txt').write_text(adb('logcat', '-b', 'crash', '-d'), encoding='utf-8')
        (OUTPUT / 'logcat.txt').write_text(adb('logcat', '-d', '-s', 'MomoUpdates:V', 'ActivityTaskManager:I',
                                              'AndroidRuntime:E'), encoding='utf-8')
        (OUTPUT / 'activities.txt').write_text(shell('dumpsys', 'activity', 'activities'), encoding='utf-8')
        (OUTPUT / 'package.txt').write_text(package_state(), encoding='utf-8')
        with (OUTPUT / 'screen.png').open('wb') as image:
            subprocess.run(['adb', 'exec-out', 'screencap', '-p'], stdout=image, timeout=15)
