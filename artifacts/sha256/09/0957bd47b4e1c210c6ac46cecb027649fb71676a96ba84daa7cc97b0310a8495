# Source-faithful physical projection of ROR schema 2 JSON.
# One logical ROR organizations recordset; locations/relationships retain array grain.
# Full ROR URL id is the source identity. Runtime-generated data.id is separate.
# raw_json is lossless JSON shape with canonical serialization, including names,
# external_ids, links, types, locations, relationships and administrative metadata.
# Model licence: CC0-1.0.
record "organizations" {
  key = ["id"]
  field "id" {
    type = "string"
    required = true
  }
  field "status" {
    type = "string"
    required = true
  }
  field "raw_json" {
    type = "string"
    required = true
  }
}

record "locations" {
  key = ["organization_id", "ordinal"]
  field "organization_id" {
    record = "organizations"
    required = true
  }
  field "ordinal" {
    type = "int"
    required = true
  }
  field "geonames_id" {
    type = "int"
  }
  field "geonames_details_json" {
    type = "string"
    required = true
  }
}

record "relationships" {
  key = ["organization_id", "ordinal"]
  field "organization_id" {
    record = "organizations"
    required = true
  }
  field "ordinal" {
    type = "int"
    required = true
  }
  field "type" {
    type = "string"
    required = true
  }
  field "id" {
    record = "organizations"
    required = true
  }
  field "label" {
    type = "string"
    required = true
  }
}
