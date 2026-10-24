# Storefront captures

## Pricing

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

## Review statistics

`review-statistics.json` contains selected fields from live `reviewStats` responses
captured on 2026-10-24 (Europe/Prague), using the context from each product's own
page in signed-in Brave. Account context parameters and unrelated response fields
were removed; complaint and sales-volume values were preserved. Each entry retains
its source URL, listing ID, and the response's self-link path.

The captures cover a key organiser, vacuum, dryer, phones, headphones, a supplement,
and a coffee machine. They include zero, low, elevated, unknown, and absent complaint
data, plus new and opened headphone listings with shared statistics. Values are
historical inputs, not current reliability claims. Failure cases mutate these
captures; the page bootstrap and transport in the tests are synthetic.
