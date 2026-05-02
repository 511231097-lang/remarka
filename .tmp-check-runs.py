import json

d = json.load(open('/tmp/checks.json'))['check_runs']
print('Count:', len(d))
for r in d:
    print('---')
    print('name:', r['name'])
    print('conclusion:', r.get('conclusion'))
    o = r.get('output') or {}
    print('title:', o.get('title'))
    print('summary:', (o.get('summary') or '')[:500])
    print('annotations_count:', o.get('annotations_count'))
    print('annotations_url:', o.get('annotations_url'))
