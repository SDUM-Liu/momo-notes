import pathlib
import re
import subprocess
import sys
import time
import xml.etree.ElementTree as ET


PACKAGE = 'io.github.sdumliu.momonotes'
OUTPUT = pathlib.Path('smoke-output')


def adb(*args):
    return subprocess.check_output(['adb', *args], timeout=25).decode('utf-8', errors='replace')


def shell(*args):
    return adb('shell', *args)


def wait_for(get, condition, description):
    until = time.monotonic() + 35
    while time.monotonic() < until:
        result = get()
        if condition(result):
            return result
        time.sleep(.7)
    raise AssertionError(description)


def hierarchy():
    shell('uiautomator', 'dump', '/sdcard/momo-smoke.xml')
    raw = shell('cat', '/sdcard/momo-smoke.xml')
    return ET.fromstring(raw)


def find_node(tree, name):
    return next((node for node in tree.iter('node') if name in (
        node.get('text'), node.get('content-desc'), node.get('resource-id')
    )), None)


def click(name):
    tree = wait_for(hierarchy, lambda root: find_node(root, name) is not None, f'Missing UI element {name}')
    node = find_node(tree, name)
    left, top, right, bottom = map(int, re.findall(r'\d+', node.attrib['bounds']))
    shell('input', 'tap', str((left + right) // 2), str((top + bottom) // 2))


def windows():
    return [chunk for chunk in re.split(r'(?=^\s+Window #\d+ Window\{)', shell('dumpsys', 'window', 'windows'), flags=re.M)
            if PACKAGE in chunk and 'ty=APPLICATION_OVERLAY' in chunk and 'mHasSurface=true' in chunk]


def main(apk):
    shell('wm', 'size', '1080x2160')
    shell('wm', 'density', '420')
    shell('input', 'keyevent', 'KEYCODE_WAKEUP')
    shell('wm', 'dismiss-keyguard')
    print(adb('install', apk))
    adb('logcat', '-c')
    print(shell('am', 'start', '-W', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER',
                '-n', PACKAGE + '/.MainActivity'))
    click('设置')
    click('在其他应用上显示桌宠')
    wait_for(lambda: shell('dumpsys', 'activity', 'activities'), lambda text: bool(re.search(
        r'mResumedActivity:.*com.android.settings|topResumedActivity=.*com.android.settings', text)), 'Overlay settings did not open')
    shell('appops', 'set', PACKAGE, 'SYSTEM_ALERT_WINDOW', 'allow')
    shell('input', 'keyevent', 'KEYCODE_BACK')
    click('返回便签')
    shell('input', 'keyevent', 'KEYCODE_HOME')
    overlays = wait_for(windows, lambda items: len(items) == 1, 'Pet did not become a real overlay after granting permission')
    frame = re.search(r'\bframe=\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]', overlays[0])
    if not frame:
        raise AssertionError('Could not locate the desktop pet window frame')
    left, top, right, bottom = map(int, frame.groups())
    shell('input', 'tap', str((left + right) // 2), str((top + bottom) // 2))
    wait_for(windows, lambda items: bool(items) and all('NOT_FOCUSABLE' not in item for item in items),
             'Tapping the pet did not open a focusable system overlay')
    print('PASS app launched, permission return enabled the pet, and pet opened a system note overlay')


if __name__ == '__main__':
    OUTPUT.mkdir(exist_ok=True)
    try:
        main(sys.argv[1])
    finally:
        (OUTPUT / 'logcat.txt').write_text(adb('logcat', '-d', '-t', '2200'), encoding='utf-8')
        (OUTPUT / 'windows.txt').write_text(shell('dumpsys', 'window', 'windows'), encoding='utf-8')
        (OUTPUT / 'activities.txt').write_text(shell('dumpsys', 'activity', 'activities'), encoding='utf-8')
        with (OUTPUT / 'screen.png').open('wb') as image:
            subprocess.run(['adb', 'exec-out', 'screencap', '-p'], stdout=image, timeout=15)
