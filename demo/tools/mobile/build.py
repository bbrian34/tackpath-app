import sys, json, subprocess, os
sys.path.insert(0, '.')
from shots import SHOTS
from layout import place
RECAP = ['Routes built from a client manifest on real road time', 'Every package scanned into its route’s bin; wrong bins rejected',
         'The STG scan on the Zebra unlocks the driver’s pickup', 'Wrong bin caught at pickup; every package scanned onto the van',
         'One GPS stream for navigation and the dispatch map', 'Photo proof at the door; dispatch updated at every step']
spec = []
for i, s in enumerate(SHOTS):
    if isinstance(s[0], str):
        o = {'kind': s[0], 'items': RECAP}
        spec.append({'i': i, 'kind': s[0], 'dur': s[1], 'overlay': o})
    else:
        t, d, step, panels, cap = s
        pl = place(panels)
        o = {'kind': 'shot', 'step': step, 'caption': cap, 'panels': [{'out': p[1], 'label': p[2]} for p in pl]}
        spec.append({'i': i, 'kind': 'shot', 't': t, 'dur': d, 'panels': [{'src': p[0], 'out': p[1]} for p in pl], 'overlay': o})
json.dump(spec, open('spec.json', 'w'), indent=1)
print(len(spec))
