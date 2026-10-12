#!/usr/bin/env python3
"""Remove the Google Analytics (gtag.js) snippet for G-SKQVLGF483 from every
.html file under a folder.

Usage:
    python3 remove_ga.py [folder] [--dry-run]

- folder defaults to the current directory
- --dry-run reports what would change and writes nothing
- skips .git, node_modules and other dot or build folders
- only touches the exact snippet for this measurement ID; anything else that
  looks like tracking is reported afterwards for you to review, never edited
- keeps each file's line endings (LF or CRLF) and encoding untouched
- safe to run twice: files with no snippet are left alone
"""
import os
import re
import sys

GA_ID = "G-SKQVLGF483"
SKIP_DIRS = {".git", "node_modules", ".wrangler", "dist", "build", ".next"}

# The three pieces Google's install instructions produce, each tolerant of
# whitespace and line-ending differences. The comment line is optional.
SNIPPET = re.compile(
    r"[ \t]*(?:<!--\s*Google tag \(gtag\.js\)\s*-->[ \t]*\r?\n[ \t]*)?"
    r"<script[^>]*\bsrc=[\"']https://www\.googletagmanager\.com/gtag/js\?id="
    + re.escape(GA_ID)
    + r"[\"'][^>]*>\s*</script>[ \t]*\r?\n"
    r"[ \t]*<script[^>]*>\s*"
    r"window\.dataLayer\s*=\s*window\.dataLayer\s*\|\|\s*\[\]\s*;\s*"
    r"function\s+gtag\s*\(\s*\)\s*\{\s*dataLayer\.push\(\s*arguments\s*\)\s*;?\s*\}\s*"
    r"gtag\(\s*['\"]js['\"]\s*,\s*new\s+Date\(\)\s*\)\s*;\s*"
    r"gtag\(\s*['\"]config['\"]\s*,\s*['\"]" + re.escape(GA_ID) + r"['\"]\s*\)\s*;?\s*"
    r"</script>[ \t]*(?:\r?\n)?"
)

LEFTOVER = re.compile(r"googletagmanager|google-analytics|gtag\s*\(|" + re.escape(GA_ID))


def walk(root):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".")]
        for name in filenames:
            yield os.path.join(dirpath, name)


def read(path):
    # newline="" keeps CRLF exactly as found
    with open(path, "r", encoding="utf-8", newline="") as fh:
        return fh.read()


def main(argv):
    dry = "--dry-run" in argv
    args = [a for a in argv if not a.startswith("--")]
    root = args[0] if args else "."
    if not os.path.isdir(root):
        print(f"Not a folder: {root}")
        return 2

    changed, untouched, leftovers, errors = [], 0, [], []

    for path in walk(root):
        ext = os.path.splitext(path)[1].lower()
        if ext not in (".html", ".htm", ".js"):
            continue
        try:
            text = read(path)
        except (UnicodeDecodeError, OSError) as exc:
            errors.append((path, str(exc)))
            continue

        if ext in (".html", ".htm"):
            new_text, n = SNIPPET.subn("", text)
        else:
            new_text, n = text, 0

        if n:
            changed.append((path, n))
            if not dry:
                tmp = path + ".tmp"
                with open(tmp, "w", encoding="utf-8", newline="") as fh:
                    fh.write(new_text)
                os.replace(tmp, path)
        else:
            untouched += 1

        # Anything tracker-shaped still present after the edit gets reported.
        remaining = new_text
        if LEFTOVER.search(remaining):
            leftovers.append(path)

    verb = "Would remove" if dry else "Removed"
    for path, n in changed:
        print(f"{verb} {n} snippet(s): {path}")
    print(f"\n{len(changed)} file(s) {'would change' if dry else 'changed'}, "
          f"{untouched} left alone.")

    if leftovers:
        print("\nStill mentions a tracker, review by hand (not edited):")
        for path in leftovers:
            print(f"  {path}")
    if errors:
        print("\nCould not read:")
        for path, msg in errors:
            print(f"  {path}: {msg}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
