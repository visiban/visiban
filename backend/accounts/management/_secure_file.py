"""Shared exclusive-create writer for one-time secrets (admin password, fuzz PAT)."""
import os
import stat


def write_secret_file(path, secret):
    """Create ``path`` exclusively with mode 0600 and write the secret to it.

    Why O_EXCL: the default path lives in the sticky, world-writable /tmp
    (Sonar python:S5443, #1379). Without O_EXCL, O_CREAT on a path an attacker
    pre-created would reuse *their* file (and its permissive mode / ownership),
    leaking the secret to them. O_EXCL guarantees we only ever write to a
    file we just created, with our 0600 mode; O_NOFOLLOW additionally refuses a
    planted symlink at the final component.

    A stale file left by a previous bootstrap run is removed first, but only if
    it is a regular file owned by this process's user -- anything else (symlink,
    another user's file, directory) is left alone and raises OSError so the
    caller can fall back or fail loudly instead of writing into an untrusted location.
    """
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        fd = os.open(path, flags, 0o600)
    except FileExistsError:
        st = os.lstat(path)
        if not stat.S_ISREG(st.st_mode) or st.st_uid != os.geteuid():
            raise
        os.unlink(path)
        fd = os.open(path, flags, 0o600)  # still O_EXCL: loses cleanly to a race
    with os.fdopen(fd, "w") as fh:
        fh.write(secret + "\n")
