# SPDX-License-Identifier: CC0-1.0
# Authored preparatory model of the ECB daily XML decoder output; no rate data.
# Native strings are preserved. time is Gregorian YYYY-MM-DD reference date,
# not a publication instant; calendar validity requires runtime validation.
# currency is the native uppercase quote code, not a country or transaction role.
# rate is a positive lexical decimal: preserve all digits and trailing zeros.
# Direction: quote-currency units per one EUR; EUR is definition context, not
# a native field or synthetic quote row. Kind: indicative ECB reference rate.
# Within one response, (time, currency) is unique semantic grain. Republishing
# can change its value. No stable logical key is asserted; currency-only adapter
# locators apply to one transient response. This model admits no execution,
# history, Get/Exists, cross-rates, reciprocals, conversions or retained paging.
record "FxReferenceQuote" {
  field "time" {
    type = "string"
    required = true
    pattern = "^[0-9]{4}-[0-9]{2}-[0-9]{2}$"
  }
  field "currency" {
    type = "string"
    required = true
    pattern = "^[A-Z]{3}$"
  }
  field "rate" {
    type = "string"
    required = true
    pattern = "^([0-9]+)([.][0-9]+)?$"
  }
}
