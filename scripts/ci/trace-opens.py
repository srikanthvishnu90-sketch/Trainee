#!/usr/bin/env python3
# trace-opens.py OUT -- CMD [ARGS...]
#
# Runs CMD and records every file and directory of the working tree that any process opened while it ran (Linux inotify
# IN_OPEN on every directory under the current directory, except .git and node_modules; directories created during the
# run are watched as they appear). It is the proof behind the CI path filter (scripts/ci/job-inputs.json): a job that is
# skipped on a pull request because none of its inputs changed must really read nothing else, and
# `node scripts/ci/job-inputs.cjs verify <job> OUT` fails the job when it opened a tracked file outside its inputs.
#
# OUT: one path per line, relative to the current directory, directories with a trailing "/". The first line is
# "# complete" or "# INCOMPLETE <why>" (an event queue overflow or a directory that could not be watched); verify
# refuses an incomplete trace. Exit status: CMD's own (128+N when a signal N ended it). Standard library only.
import ctypes
import ctypes.util
import errno
import os
import select
import signal
import struct
import subprocess
import sys

IN_OPEN = 0x00000020
IN_MOVED_TO = 0x00000080
IN_CREATE = 0x00000100
IN_Q_OVERFLOW = 0x00004000
IN_IGNORED = 0x00008000
IN_ISDIR = 0x40000000
IN_NONBLOCK = 0o4000
IN_CLOEXEC = 0o2000000
MASK = IN_OPEN | IN_CREATE | IN_MOVED_TO
SKIP = {".git", "node_modules"}
EVENT = struct.Struct("iIII")


def main(argv):
    if len(argv) < 4 or argv[2] != "--":
        print("usage: trace-opens.py OUT -- CMD [ARGS...]", file=sys.stderr)
        return 2
    out_path, cmd = argv[1], argv[3:]
    libc = ctypes.CDLL(ctypes.util.find_library("c") or "libc.so.6", use_errno=True)
    fd = libc.inotify_init1(IN_NONBLOCK | IN_CLOEXEC)
    if fd < 0:
        print(f"trace-opens: inotify_init1 failed: {os.strerror(ctypes.get_errno())}", file=sys.stderr)
        return 2
    root = os.getcwd()
    watches = {}  # wd -> path relative to root ("" for the root)
    problems = []
    opened = set()

    def watch(rel):
        path = os.path.join(root, rel) if rel else root
        wd = libc.inotify_add_watch(fd, path.encode(), MASK)
        if wd < 0:
            err = ctypes.get_errno()
            if err != errno.ENOENT:  # a directory removed before it could be watched held nothing to read
                problems.append(f"cannot watch {rel or '.'}: {os.strerror(err)}")
            return
        watches[wd] = rel
        try:
            entries = list(os.scandir(path))
        except OSError:
            return
        for e in entries:
            if e.name not in SKIP and e.is_dir(follow_symlinks=False):
                watch(os.path.join(rel, e.name) if rel else e.name)

    def drain():
        while True:
            try:
                buf = os.read(fd, 1 << 20)
            except BlockingIOError:
                return
            except OSError as e:
                if e.errno == errno.EINTR:
                    continue
                raise
            if not buf:
                return
            i = 0
            while i + EVENT.size <= len(buf):
                wd, mask, _cookie, length = EVENT.unpack_from(buf, i)
                name = buf[i + EVENT.size:i + EVENT.size + length].split(b"\0", 1)[0].decode("utf-8", "surrogateescape")
                i += EVENT.size + length
                if mask & IN_Q_OVERFLOW:
                    problems.append("the inotify event queue overflowed: events were lost")
                    continue
                if mask & IN_IGNORED:
                    watches.pop(wd, None)
                    continue
                base = watches.get(wd)
                if base is None:
                    continue
                rel = os.path.join(base, name) if (base and name) else (name or base)
                if mask & IN_OPEN:
                    if mask & IN_ISDIR:
                        opened.add((rel + "/") if rel else "./")
                    else:
                        opened.add(rel)
                if mask & (IN_CREATE | IN_MOVED_TO) and mask & IN_ISDIR and name and name not in SKIP:
                    watch(rel)

    watch("")
    drain()  # the watch walk's own directory opens are queued synchronously: read and forget them before CMD starts
    opened.clear()
    child = subprocess.Popen(cmd)
    forward = lambda signum, _frame: child.send_signal(signum)
    signal.signal(signal.SIGTERM, forward)
    signal.signal(signal.SIGINT, forward)
    while True:
        try:
            ready, _, _ = select.select([fd], [], [], 0.5)
        except InterruptedError:
            ready = []
        if ready:
            drain()
        if child.poll() is not None:
            drain()
            break
    os.close(fd)
    with open(out_path, "w") as f:
        f.write("# complete\n" if not problems else "# INCOMPLETE " + "; ".join(sorted(set(problems))[:5]) + "\n")
        for p in sorted(opened):
            f.write(p + "\n")
    print(f"trace-opens: {len(opened)} paths opened under {root}, {len(watches)} directories watched"
          f"{'' if not problems else ', INCOMPLETE: ' + problems[0]}", file=sys.stderr)
    rc = child.returncode
    return 128 - rc if rc < 0 else rc


if __name__ == "__main__":
    sys.exit(main(sys.argv))
