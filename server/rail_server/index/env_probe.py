"""Describe a Python environment as JSON on stdout.

Runs with the USER's interpreter (design plan §9.2), so it must use the
standard library only and work on Python 3.8+. It only reads metadata: it
never imports user or third-party packages. It introspects ``builtins``, the
modules compiled into the interpreter, and an allowlist of standard C
extension modules.
"""

import importlib
import inspect
import json
import os
import platform
import site
import sys
import sysconfig

try:
    from importlib import metadata as importlib_metadata
except ImportError:  # pragma: no cover - Python < 3.8
    importlib_metadata = None  # type: ignore

SKIP_DIR_NAMES = {
    "__pycache__",
    "test",
    "tests",
    "testing",
    "site-packages",
    "dist-packages",
    "idlelib",
    "turtledemo",
    "ensurepip",
    "pydoc_data",
}

# Standard-library C extension modules that are safe to import for
# introspection (no side effects at import time).
DYNLOAD_ALLOWLIST = {
    "array",
    "binascii",
    "cmath",
    "fcntl",
    "grp",
    "math",
    "mmap",
    "resource",
    "select",
    "syslog",
    "termios",
    "unicodedata",
    "zlib",
    "_asyncio",
    "_bisect",
    "_blake2",
    "_bz2",
    "_contextvars",
    "_csv",
    "_datetime",
    "_decimal",
    "_hashlib",
    "_heapq",
    "_json",
    "_lzma",
    "_md5",
    "_pickle",
    "_posixsubprocess",
    "_queue",
    "_random",
    "_sha1",
    "_sha2",
    "_sha256",
    "_sha3",
    "_sha512",
    "_socket",
    "_ssl",
    "_statistics",
    "_struct",
    "_zoneinfo",
}
DENY = {"_tkinter", "readline", "_curses", "_curses_panel", "antigravity", "this"}

MAX_DOC = 4000


def _is_test_file(name):
    return name.startswith("test_") or name.endswith("_test.py") or name == "conftest.py"


def _module_name(rel_path):
    parts = rel_path.replace("\\", "/").split("/")
    if not parts or parts[0] in ("..", "") or not parts[-1].endswith(".py"):
        return None
    last = parts[-1][:-3]
    parts = parts[:-1] if last == "__init__" else parts[:-1] + [last]
    if not parts:
        return None
    for p in parts:
        if not p.isidentifier():
            return None
    return ".".join(parts)


def _usable(rel_path):
    parts = rel_path.replace("\\", "/").split("/")
    if any(p in SKIP_DIR_NAMES for p in parts[:-1]):
        return False
    return not _is_test_file(parts[-1])


def collect_dists():
    out = []
    if importlib_metadata is None:
        return out
    seen = set()
    for dist in importlib_metadata.distributions():
        try:
            name = dist.metadata["Name"]
            version = dist.version
        except Exception:
            continue
        if not name or not version:
            continue
        key = name.lower().replace("_", "-").replace(".", "-")
        if key in seen:
            continue
        seen.add(key)
        py_files = []
        modules = []
        for f in dist.files or []:
            rel = str(f)
            if not rel.endswith(".py") or not _usable(rel):
                continue
            mod = _module_name(rel)
            if mod is None:
                continue
            try:
                path = os.path.abspath(str(dist.locate_file(f)))
            except Exception:
                continue
            if not os.path.isfile(path):
                continue
            py_files.append(path)
            modules.append(mod)
        out.append({"name": name, "version": version, "py_files": py_files, "modules": modules})
    out.sort(key=lambda d: d["name"].lower())
    return out


def collect_stdlib(stdlib_dir):
    py_files = []
    modules = []
    if not stdlib_dir or not os.path.isdir(stdlib_dir):
        return py_files, modules
    for root, dirs, files in os.walk(stdlib_dir):
        rel_root = os.path.relpath(root, stdlib_dir)
        dirs[:] = sorted(
            d
            for d in dirs
            if d not in SKIP_DIR_NAMES
            and not d.startswith(".")
            and d != "lib-dynload"
            and not d.startswith("python")
            and d != "config"
        )
        for name in sorted(files):
            if not name.endswith(".py") or _is_test_file(name):
                continue
            rel = name if rel_root == "." else os.path.join(rel_root, name)
            mod = _module_name(rel)
            if mod is None:
                continue
            py_files.append(os.path.join(root, name))
            modules.append(mod)
    return py_files, modules


def _signature(obj, name):
    try:
        return name + str(inspect.signature(obj))
    except (TypeError, ValueError):
        pass
    doc = getattr(obj, "__doc__", None)
    if isinstance(doc, str):
        first = doc.strip().splitlines()[0] if doc.strip() else ""
        if first.startswith(name + "(") and first.rstrip().endswith(")"):
            return first.strip()
        if "(" in first and first.split("(", 1)[0].strip().isidentifier() and ")" in first:
            return first.strip()
    return None


def _doc(obj):
    doc = getattr(obj, "__doc__", None)
    if not isinstance(doc, str):
        return None
    doc = inspect.cleandoc(doc)
    return doc[:MAX_DOC] if doc else None


def _is_c_object(obj):
    if inspect.isclass(obj):
        return not any(inspect.isfunction(v) for v in vars(obj).values())
    return not inspect.isfunction(obj) and not inspect.ismethod(obj)


def _kind(obj):
    if inspect.isclass(obj):
        return "class"
    if inspect.ismodule(obj):
        return "module"
    if callable(obj):
        return "function"
    return None


def introspect_module(mod_name, mod, out, seen):
    entry = {
        "qualname": mod_name,
        "module": mod_name,
        "kind": "module",
        "signature": None,
        "doc": _doc(mod),
    }
    out.append(entry)
    for name in sorted(dir(mod)):
        if name.startswith("__"):
            continue
        try:
            obj = getattr(mod, name)
        except Exception:
            continue
        kind = _kind(obj)
        if kind is None or kind == "module":
            continue
        owner = getattr(obj, "__module__", None)
        if not isinstance(owner, str) or not owner:
            owner = mod_name
        if owner != mod_name and not _is_c_object(obj):
            continue  # a Python-level object; indexed from its source instead
        # C objects are named where users import them from: _collections.deque
        # reports __module__ == "collections".
        qual = owner + "." + name
        if qual in seen:
            continue
        seen.add(qual)
        out.append(
            {
                "qualname": qual,
                "module": mod_name,
                "kind": kind,
                "signature": _signature(obj, name),
                "doc": _doc(obj),
            }
        )
        if kind == "class":
            for attr in sorted(vars(obj)):
                if attr.startswith("_") and attr not in (
                    "__init__",
                    "__call__",
                    "__getitem__",
                    "__contains__",
                    "__iter__",
                    "__len__",
                ):
                    continue
                try:
                    member = getattr(obj, attr)
                except Exception:
                    continue
                if not callable(member):
                    continue
                mqual = qual + "." + attr
                if mqual in seen:
                    continue
                seen.add(mqual)
                out.append(
                    {
                        "qualname": mqual,
                        "module": mod_name,
                        "kind": "method",
                        "signature": _signature(member, attr),
                        "doc": _doc(member),
                    }
                )


def collect_runtime():
    out = []
    seen = set()
    names = ["builtins"]
    names += sorted(n for n in sys.builtin_module_names if n not in ("builtins", "__main__"))
    dynload = set()
    for d in sys.path:
        if d and os.path.basename(d) == "lib-dynload" and os.path.isdir(d):
            for f in os.listdir(d):
                base = f.split(".", 1)[0]
                if base in DYNLOAD_ALLOWLIST:
                    dynload.add(base)
    names += sorted(dynload - set(names))
    for mod_name in names:
        if mod_name in DENY:
            continue
        try:
            mod = importlib.import_module(mod_name)
        except Exception:
            continue
        try:
            introspect_module(mod_name, mod, out, seen)
        except Exception:
            continue
    return out


def site_dirs():
    dirs = []
    try:
        dirs.extend(site.getsitepackages())
    except Exception:
        pass
    try:
        user = site.getusersitepackages()
        if user:
            dirs.append(user)
    except Exception:
        pass
    for p in sys.path:
        if p and ("site-packages" in p or "dist-packages" in p):
            dirs.append(p)
    seen = []
    for d in dirs:
        d = os.path.abspath(d)
        if os.path.isdir(d) and d not in seen:
            seen.append(d)
    return seen


def main():
    stdlib_dir = sysconfig.get_paths().get("stdlib")
    std_files, std_modules = collect_stdlib(stdlib_dir)
    data = {
        "python_version": platform.python_version(),
        "implementation": platform.python_implementation(),
        "executable": sys.executable,
        "prefix": sys.prefix,
        "stdlib_dir": stdlib_dir,
        "site_dirs": site_dirs(),
        "dists": collect_dists(),
        "stdlib": {"py_files": std_files, "modules": std_modules},
        "builtins": collect_runtime() if "--no-runtime" not in sys.argv else [],
    }
    out = json.dumps(data)
    sys.stdout.write(out)
    sys.stdout.flush()


if __name__ == "__main__":
    main()
