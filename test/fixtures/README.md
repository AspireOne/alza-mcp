# Pricing captures

These fixtures retain product identity and pricing markup captured on 2026-10-16
(Europe/Prague). Unrelated content, SVGs, account identifiers, tracking payloads,
and account-specific request URLs were removed. Prices are historical test
inputs, not current offers.

| Files | Source | Session |
|---|---|---|
| `coupon-detail.html`, `anonymous-coupon-detail.html` | [GymBeam 180 capsules](https://www.alza.cz/gymbeam-horcik-chelat-bisglycinat-180-kapsli-d12662568.htm) | Signed-in rendered page; anonymous server HTML fetched without credentials |
| `coupon-search.html` | [GymBeam search](https://www.alza.cz/search.htm?exps=GymBeam%20Ho%C5%99%C4%8D%C3%ADk%20chel%C3%A1t) | Signed-in rendered cards |
| `benefit-detail.html`, `benefit-search.html` | [Siemens product](https://www.alza.cz/siemens-tp551e19-eq500-iaroma-d13458454.htm), [search](https://www.alza.cz/search.htm?exps=SIEMENS%20TP551E19) | Signed-in company benefit; rendered detail and filter API `Boxes` HTML |
| `no-coupon-detail.html` | [GymBeam 90 capsules](https://www.alza.cz/gymbeam-horcik-chelat-bisglycinat-90-kapsli-d7191519.htm) | Signed-in rendered page |

Tests derive missing, malformed, duplicated, and multiple-coupon cases from
these captures. Those mutations are synthetic.
