#!/bin/bash
# 合并 sources/*.json -> booksource.json
set -e
cd "$(dirname "$0")"

python3 - <<'EOF'
import json, glob

merged = []
for f in sorted(glob.glob('sources/*.json')):
    data = json.load(open(f, encoding='utf-8'))
    if isinstance(data, list):
        merged += data
    else:
        merged.append(data)

with open('booksource.json', 'w', encoding='utf-8') as fp:
    json.dump(merged, fp, ensure_ascii=False, indent=2)

print(f'合并 {len(glob.glob("sources/*.json"))} 个文件 -> booksource.json ({len(merged)} 个书源)')
EOF
