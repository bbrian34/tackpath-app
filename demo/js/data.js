/* TackPath demo — the fictional operation.
   Everything here is invented for the demo: the courier company, people,
   businesses, phone numbers (555-01xx) and package numbers. Street names are
   real Atlanta streets so the map reads naturally; street geometry is a
   hand-drawn approximation (no map service is called). */
(function (root) {
  'use strict';

  const COMPANY = {
    id: 'd3m0c0de-0000-4000-8000-000000000001',
    slug: 'peachline',
    name: 'Peachline Courier',
    code: 'demo-only',
    dispatchPhone: '4045550140',
    hub: { name: 'Peachline Hub · West Midtown', address: '1150 Huff Rd NW, Atlanta, GA 30318', lat: 33.7876, lng: -84.4143 },
    // SmartSort reads each company's block policy (tp_ss_policy_<org>).
    // Peachline runs short same-day blocks.
    policy: { targetBlockMin: 45, maxBlockMin: 58, maxDriveShare: 0.62 }
  };

  // Drivers on today's roster. The first one is the driver the demo follows.
  const DRIVERS = [
    { id: 'drv-0001', name: 'Andre Coleman', phone: '4045550161', vehicle: 'Ford Transit 250', featured: true },
    { id: 'drv-0002', name: 'Priya Nair', phone: '4045550162', vehicle: 'Ram ProMaster City' },
    { id: 'drv-0003', name: 'Luis Ortega', phone: '4045550163', vehicle: 'Ford Transit Connect' },
    { id: 'drv-0004', name: 'Dana Whitaker', phone: '4045550164', vehicle: 'Nissan NV200' }
  ];

  // ── STREETS ── [name, class, [[lat,lng],...]]
  // class: 'major' | 'street' | 'highway' (highways are drawn, not driven).
  const STREETS = [
    ['Northside Dr NW', 'major', [[33.7480, -84.4005], [33.7600, -84.4022], [33.7713, -84.4040], [33.7790, -84.4048], [33.7862, -84.4055], [33.7915, -84.4060], [33.8010, -84.4078]]],
    ['Howell Mill Rd NW', 'major', [[33.7790, -84.4118], [33.7862, -84.4126], [33.7930, -84.4134], [33.8010, -84.4142]]],
    ['Marietta St NW', 'major', [[33.7555, -84.3915], [33.7600, -84.3948], [33.7650, -84.3988], [33.7713, -84.4040], [33.7790, -84.4118], [33.7840, -84.4175]]],
    ['Huff Rd NW', 'street', [[33.7840, -84.4175], [33.7876, -84.4143], [33.7905, -84.4105], [33.7915, -84.4060]]],
    ['Techwood Dr NW', 'street', [[33.7600, -84.3935], [33.7713, -84.3935], [33.7768, -84.3935], [33.7815, -84.3935]]],
    ['Spring St NW', 'major', [[33.7520, -84.3897], [33.7600, -84.3897], [33.7713, -84.3895], [33.7815, -84.3893], [33.7862, -84.3893], [33.7915, -84.3892]]],
    ['W Peachtree St NW', 'major', [[33.7600, -84.3878], [33.7713, -84.3876], [33.7815, -84.3875], [33.7862, -84.3874], [33.7915, -84.3872], [33.7990, -84.3870]]],
    ['Peachtree St NE', 'major', [[33.7480, -84.3884], [33.7545, -84.3880], [33.7600, -84.3870], [33.7713, -84.3858], [33.7727, -84.3857], [33.7815, -84.3851], [33.7862, -84.3849], [33.7915, -84.3852], [33.7990, -84.3866]]],
    ['Juniper St NE', 'street', [[33.7713, -84.3826], [33.7727, -84.3826], [33.7768, -84.3825], [33.7815, -84.3823], [33.7862, -84.3822]]],
    ['Piedmont Ave NE', 'major', [[33.7520, -84.3812], [33.7600, -84.3805], [33.7645, -84.3800], [33.7713, -84.3790], [33.7727, -84.3788], [33.7768, -84.3780], [33.7815, -84.3772], [33.7862, -84.3765], [33.7990, -84.3750]]],
    ['Boulevard NE', 'major', [[33.7520, -84.3718], [33.7600, -84.3716], [33.7645, -84.3714], [33.7713, -84.3712], [33.7727, -84.3712]]],
    ['Monroe Dr NE', 'major', [[33.7727, -84.3672], [33.7815, -84.3676], [33.7862, -84.3680], [33.7990, -84.3690]]],
    ['North Ave', 'major', [[33.7713, -84.4040], [33.7713, -84.3935], [33.7713, -84.3895], [33.7713, -84.3876], [33.7713, -84.3858], [33.7713, -84.3826], [33.7713, -84.3790], [33.7713, -84.3712], [33.7713, -84.3650]]],
    ['Ponce de Leon Ave NE', 'major', [[33.7727, -84.3857], [33.7727, -84.3826], [33.7727, -84.3788], [33.7727, -84.3712], [33.7727, -84.3672], [33.7732, -84.3630]]],
    ['5th St NW', 'street', [[33.7768, -84.3935], [33.7768, -84.3895], [33.7768, -84.3876], [33.7768, -84.3854], [33.7768, -84.3825], [33.7768, -84.3780]]],
    ['10th St NW', 'major', [[33.7815, -84.4120], [33.7815, -84.4048], [33.7815, -84.3935], [33.7815, -84.3893], [33.7815, -84.3875], [33.7815, -84.3851], [33.7815, -84.3823], [33.7815, -84.3772], [33.7815, -84.3676]]],
    ['14th St NW', 'major', [[33.7862, -84.4126], [33.7862, -84.4055], [33.7862, -84.3893], [33.7862, -84.3874], [33.7862, -84.3849], [33.7862, -84.3822], [33.7862, -84.3765], [33.7862, -84.3680]]],
    ['17th St NW', 'major', [[33.7915, -84.4060], [33.7915, -84.3990], [33.7915, -84.3892], [33.7915, -84.3872], [33.7915, -84.3852]]],
    ['Ralph McGill Blvd NE', 'street', [[33.7645, -84.3880], [33.7645, -84.3800], [33.7645, -84.3714], [33.7645, -84.3660]]],
    ['Andrew Young Intl Blvd', 'major', [[33.7600, -84.4022], [33.7600, -84.3948], [33.7600, -84.3935], [33.7600, -84.3897], [33.7600, -84.3878], [33.7600, -84.3870], [33.7600, -84.3805], [33.7600, -84.3716]]],
    ['Edgewood Ave SE', 'street', [[33.7545, -84.3880], [33.7547, -84.3812], [33.7552, -84.3718], [33.7555, -84.3660]]],
    ['Atlantic Dr NW', 'street', [[33.7915, -84.3990], [33.7955, -84.3990], [33.7990, -84.3985]]],
    ['I-75/85 Downtown Connector', 'highway', [[33.7470, -84.3905], [33.7600, -84.3910], [33.7713, -84.3912], [33.7815, -84.3910], [33.7880, -84.3912], [33.7950, -84.3990], [33.8020, -84.4070]]],
    ['I-85 N', 'highway', [[33.7880, -84.3912], [33.7960, -84.3860], [33.8030, -84.3800]]]
  ];

  // Landmarks drawn on the map (areas and labels only).
  const AREAS = [
    { name: 'Piedmont Park', kind: 'park', poly: [[33.7862, -84.3765], [33.7880, -84.3712], [33.7860, -84.3690], [33.7815, -84.3690], [33.7790, -84.3740], [33.7815, -84.3770]] },
    { name: 'Georgia Tech', kind: 'campus', poly: [[33.7815, -84.4040], [33.7815, -84.3940], [33.7713, -84.3940], [33.7713, -84.4030]] },
    { name: 'Centennial Olympic Park', kind: 'park', poly: [[33.7625, -84.3945], [33.7625, -84.3920], [33.7590, -84.3920], [33.7590, -84.3945]] },
    { name: 'Atlantic Station', kind: 'district', poly: [[33.7990, -84.4055], [33.7990, -84.3975], [33.7920, -84.3975], [33.7920, -84.4055]] }
  ];
  const LABELS = [
    { text: 'MIDTOWN', lat: 33.7840, lng: -84.3840 },
    { text: 'DOWNTOWN', lat: 33.7570, lng: -84.3865 },
    { text: 'WEST MIDTOWN', lat: 33.7925, lng: -84.4150 },
    { text: 'OLD FOURTH WARD', lat: 33.7640, lng: -84.3690 },
    { text: 'HOME PARK', lat: 33.7890, lng: -84.4010 }
  ];

  // ── MANIFEST ── one row per manifest line, exactly the dispatcher CSV columns.
  // Coordinates are where each address sits on the demo map (the demo's
  // geocoder answers with these; no geocoding service is called).
  const STOPS = [
    { address: '1075 Peachtree St NE, Atlanta, GA 30309', lat: 33.7838, lng: -84.3850, recipient: 'Ellis & Grant LLP', phone: '4045550171', unit: 'Suite 1200', access_notes: 'Reception on 12; badge desk in lobby', lines: [['PCX4102217', 2], ['PCX4102218', 1]] },
    { address: '980 Piedmont Ave NE, Atlanta, GA 30309', lat: 33.7808, lng: -84.3773, recipient: 'Rebecca Torres', phone: '4045550172', unit: '3B', gate_code: '4471', lines: [['PCX4102231', 1]] },
    { address: '1100 Spring St NW, Atlanta, GA 30309', lat: 33.7843, lng: -84.3893, recipient: 'Spring Quarter Dental', phone: '4045550173', delivery_notes: 'Business hours 8am-4pm', lines: [['PCX4102240', 2]] },
    { address: '1280 W Peachtree St NW, Atlanta, GA 30309', lat: 33.7885, lng: -84.3873, recipient: 'Hannah Kim', phone: '4045550174', unit: 'Apt 1408', access_notes: 'Concierge desk, ask for package room', signature_required: true, lines: [['PCX4102255', 1]] },
    { address: '750 Juniper St NE, Atlanta, GA 30308', lat: 33.7745, lng: -84.3825, recipient: 'James Whitfield', phone: '4045550175', lines: [['PCX4102263', 1], ['PCX4102264', 1]] },
    { address: '210 Ponce de Leon Ave NE, Atlanta, GA 30308', lat: 33.7727, lng: -84.3800, recipient: 'Gilbert Street Bakery', phone: '4045550176', delivery_notes: 'Back door off the alley', lines: [['PCX4102270', 3]] },
    { address: '1199 Howell Mill Rd NW, Atlanta, GA 30318', lat: 33.7880, lng: -84.4128, recipient: 'Westside Provisions Co.', phone: '4045550177', lines: [['PCX4102281', 2]] },
    { address: '1000 Marietta St NW, Atlanta, GA 30318', lat: 33.7760, lng: -84.4087, recipient: 'Foundry Row Studios', phone: '4045550178', unit: 'Unit 4', lines: [['PCX4102290', 1]] },
    { address: '905 Northside Dr NW, Atlanta, GA 30318', lat: 33.7795, lng: -84.4049, recipient: 'Marcus Reed', phone: '4045550179', lines: [['PCX4102302', 1]] },
    { address: '245 17th St NW, Atlanta, GA 30363', lat: 33.7915, lng: -84.3940, recipient: 'Atlantic Yards Fitness', phone: '4045550180', lines: [['PCX4102315', 2], ['PCX4102316', 1]] },
    { address: '1380 Atlantic Dr NW, Atlanta, GA 30363', lat: 33.7955, lng: -84.3990, recipient: 'Nora Bennett', phone: '4045550181', unit: 'Apt 612', lines: [['PCX4102322', 1]] },
    { address: '1430 Howell Mill Rd NW, Atlanta, GA 30318', lat: 33.7950, lng: -84.4136, recipient: 'Blue Kettle Coffee', phone: '4045550182', lines: [['PCX4102330', 2]] },
    { address: '55 Andrew Young Intl Blvd NW, Atlanta, GA 30303', lat: 33.7600, lng: -84.3915, recipient: 'Centennial Suites Hotel', phone: '4045550183', access_notes: 'Deliver to bell desk', lines: [['PCX4102341', 2]] },
    { address: '200 Edgewood Ave SE, Atlanta, GA 30303', lat: 33.7548, lng: -84.3790, recipient: 'Sweet Auburn Books', phone: '4045550184', lines: [['PCX4102352', 1]] },
    { address: '650 Ralph McGill Blvd NE, Atlanta, GA 30312', lat: 33.7645, lng: -84.3690, recipient: 'Olivia Grant', phone: '4045550185', lines: [['PCX4102360', 1]] },
    { address: '540 Boulevard NE, Atlanta, GA 30308', lat: 33.7680, lng: -84.3713, recipient: 'Daniel Brooks', phone: '4045550186', unit: 'Apt 2', lines: [['PCX4102371', 1]] },
    { address: '675 Ponce de Leon Ave NE, Atlanta, GA 30308', lat: 33.7730, lng: -84.3650, recipient: 'Market Hall Vendors', phone: '4045550187', access_notes: 'Loading dock B, north side', lines: [['PCX4102384', 2], ['PCX4102385', 1]] }
  ];

  // The CSV the courier's system sends over this morning.
  function manifestCsv() {
    const head = 'order_id,recipient,address,packages,tracking_number,phone,unit,access_notes,gate_code,delivery_notes,signature_required';
    const q = (v) => { v = v == null ? '' : String(v); return /[",]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    const rows = [];
    let n = 24081;
    STOPS.forEach((s) => s.lines.forEach(([tn, count]) => {
      rows.push([('PC-' + (n++)), s.recipient, s.address, count, tn, s.phone, s.unit || '', s.access_notes || '',
        s.gate_code || '', s.delivery_notes || '', s.signature_required ? 'yes' : ''].map(q).join(','));
    }));
    return head + '\n' + rows.join('\n') + '\n';
  }
  const totals = () => {
    let lines = 0, pkgs = 0;
    STOPS.forEach((s) => s.lines.forEach(([, c]) => { lines++; pkgs += c; }));
    return { stops: STOPS.length, lines, packages: pkgs };
  };

  root.DEMO_DATA = { COMPANY, DRIVERS, STREETS, AREAS, LABELS, STOPS, manifestCsv, totals };
})(typeof window !== 'undefined' ? window : globalThis);
