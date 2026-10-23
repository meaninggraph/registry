# Countries data: licence, attribution and changes

The data in this database is licensed under the
[Creative Commons Attribution 4.0 International licence (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/)
(SPDX `CC-BY-4.0`; full legal text in the repository's [`LICENSE`](../LICENSE)).
It is a **derived and modified** work of the following sources. Neither GeoNames
nor the World Bank endorses this database or the changes made to their data.
The `sources` table of the database carries the same attribution row by row.

## GeoNames: countries, ISO codes and currency (CC BY 4.0)

- Columns of `countries` other than the population columns (`iso2`, `iso3`,
  `name`, `continent`, `capital`, `currency_code`, `currency_name`, `area_km2`,
  `phone_prefix`, `tld`, `geonameid`).
- Source: © [GeoNames](https://www.geonames.org/), `countryInfo.txt` from
  <https://download.geonames.org/export/dump/>, licensed under
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) (terms at
  <https://www.geonames.org/export/>).
- Changes: re-keyed by upper-case ISO 3166-1 alpha-2 code, columns renamed,
  the English name kept as `name`, the undated GeoNames population left out
  (population comes from the World Bank), and stored as SQLite.

## World Bank: population (CC BY 4.0)

- Columns `population`, `population_year` and `population_source_url` of
  `countries` (`population_source_id` = `worldbank-sp-pop-totl`).
- Source: The World Bank, World Development Indicators, indicator
  [SP.POP.TOTL](https://data.worldbank.org/indicator/SP.POP.TOTL) ("Population,
  total"), retrieved from the World Bank Indicators API v2
  (`https://api.worldbank.org/v2/country/all/indicator/SP.POP.TOTL?format=json&mrnev=1`)
  on 2026-10-02 (dataset last updated by the World Bank on 2026-07-13). Data ©
  The World Bank, licensed under
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) (see the World
  Bank's [terms of use for datasets](https://datacatalog.worldbank.org/public-licenses#cc-by)).
- Changes: only the most recent non-empty observation per country is kept with
  its year; World Bank aggregates (regions, income groups, "World") and
  entities without a GeoNames country are dropped; rows are matched to
  countries by ISO 3166-1 alpha-3 code. Values are the World Bank's figures as
  published, not recomputed. 36 territories have no observation and keep a
  NULL population.

## Country aliases (DataTug)

`country_aliases` is hand-checked mapping data with no third-party content:
the spellings Chinook (`Invoice.BillingCountry`) and Northwind
(`Orders.ShipCountry`) use, each mapped to a `countries` row, with the system
and the kind of match recorded in `source`.

## Provenance

The recipe input is the geo reference data vendored in
[datatug/datatug-demo-project](https://github.com/datatug/datatug-demo-project/tree/ade953b68b1b18fcd50d361ed0e18b7043d8a364/demo-project-1/data/geo)
at commit `ade953b68b1b18fcd50d361ed0e18b7043d8a364`, which was itself copied
from [ingitdb/geo-ingitdb](https://github.com/ingitdb/geo-ingitdb) at commit
`a874fb0a95183f536cb574a5ccb45e362274eb6d`. `scripts/rebuild-source.py`
rebuilds `data-source/source.sqlite` from it.
