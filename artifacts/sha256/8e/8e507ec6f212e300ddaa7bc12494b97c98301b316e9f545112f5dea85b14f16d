# Licence: MIT (https://github.com/demo-db/chinook/blob/main/LICENSE).
# The model restates the schema of the Chinook Database, Copyright (c) 2008-2024
# Luis Rocha, MIT (https://github.com/lerocha/chinook-database/blob/master/LICENSE.md),
# so that notice applies to it too. The meaning file chinook.meaning.yaml is CC0-1.0.
#
# Chinook sample database: storage-neutral data model (ModelSpec 1.0-draft-2).
#
# Module short name: chinook (references use modelspec:///chinook.<Record>).
# Source of the structure: the pinned upstream SQLite fixture
# (data-source/source.sqlite). Record type and field names are the
# upstream table and column names, so each field matches one published
# column one to one. scripts/test-data.mjs fails when a record type's key,
# or the set of record types, disagrees with metadata/schema.json.
#
# Reading notes:
# - A field with `record = "X"` is a reference to an X record. It holds
#   X's key value (for example Album.ArtistId holds an Artist.ArtistId).
# - NVARCHAR(n) columns are `string` with `max_len = n`.
# - NUMERIC(10,2) columns are `decimal`; ModelSpec has no precision or scale
#   attribute, so "10 digits, 2 after the point" is recorded here only.
# - DATETIME columns are `datetime`. Every Chinook value has a midnight time
#   part ("2021-01-01 00:00:00"); the model keeps the stored type.
# - Meaning (what a column is for, synonyms, units, labels in other languages)
#   lives in chinook.meaning.yaml, not here.

# A recording artist or band.
record "Artist" {
  key = ["ArtistId"]

  field "ArtistId" {
    type     = "int"
    required = true
  }

  field "Name" {
    type    = "string"
    max_len = 120
  }
}

# An album released by one artist.
record "Album" {
  key = ["AlbumId"]

  field "AlbumId" {
    type     = "int"
    required = true
  }

  field "Title" {
    type     = "string"
    required = true
    max_len  = 160
  }

  field "ArtistId" {
    record   = "Artist"
    required = true
  }
}

# One audio or video track sold by the store.
record "Track" {
  key = ["TrackId"]

  field "TrackId" {
    type     = "int"
    required = true
  }

  field "Name" {
    type     = "string"
    required = true
    max_len  = 200
  }

  field "AlbumId" {
    record = "Album"
  }

  field "MediaTypeId" {
    record   = "MediaType"
    required = true
  }

  field "GenreId" {
    record = "Genre"
  }

  field "Composer" {
    type    = "string"
    max_len = 220
  }

  # Duration in milliseconds.
  field "Milliseconds" {
    type     = "int"
    required = true
  }

  # File size in bytes.
  field "Bytes" {
    type = "int"
  }

  # List price of one copy. NUMERIC(10,2).
  field "UnitPrice" {
    type     = "decimal"
    required = true
  }
}

# A music genre.
record "Genre" {
  key = ["GenreId"]

  field "GenreId" {
    type     = "int"
    required = true
  }

  field "Name" {
    type    = "string"
    max_len = 120
  }
}

# A file format and encoding, such as "MPEG audio file".
record "MediaType" {
  key = ["MediaTypeId"]

  field "MediaTypeId" {
    type     = "int"
    required = true
  }

  field "Name" {
    type    = "string"
    max_len = 120
  }
}

# A named list of tracks.
record "Playlist" {
  key = ["PlaylistId"]

  field "PlaylistId" {
    type     = "int"
    required = true
  }

  field "Name" {
    type    = "string"
    max_len = 120
  }
}

# Membership of a track in a playlist: the many-to-many link between Playlist
# and Track. ModelSpec has no many-to-many construct; an association record type
# whose key is its two references is how the model says it.
record "PlaylistTrack" {
  key = ["PlaylistId", "TrackId"]

  field "PlaylistId" {
    record   = "Playlist"
    required = true
  }

  field "TrackId" {
    record   = "Track"
    required = true
  }
}

# A person who buys from the store.
record "Customer" {
  key = ["CustomerId"]

  field "CustomerId" {
    type     = "int"
    required = true
  }

  field "FirstName" {
    type     = "string"
    required = true
    max_len  = 40
  }

  field "LastName" {
    type     = "string"
    required = true
    max_len  = 20
  }

  field "Company" {
    type    = "string"
    max_len = 80
  }

  field "Address" {
    type    = "string"
    max_len = 70
  }

  field "City" {
    type    = "string"
    max_len = 40
  }

  field "State" {
    type    = "string"
    max_len = 40
  }

  # Country name as Chinook spells it ("USA", "Czech Republic").
  field "Country" {
    type    = "string"
    max_len = 40
  }

  field "PostalCode" {
    type    = "string"
    max_len = 10
  }

  field "Phone" {
    type    = "string"
    max_len = 24
  }

  field "Fax" {
    type    = "string"
    max_len = 24
  }

  field "Email" {
    type     = "string"
    required = true
    max_len  = 60
    format   = "email"
  }

  # The employee who supports this customer.
  field "SupportRepId" {
    record = "Employee"
  }
}

# A store employee.
record "Employee" {
  key = ["EmployeeId"]

  field "EmployeeId" {
    type     = "int"
    required = true
  }

  field "LastName" {
    type     = "string"
    required = true
    max_len  = 20
  }

  field "FirstName" {
    type     = "string"
    required = true
    max_len  = 20
  }

  field "Title" {
    type    = "string"
    max_len = 30
  }

  # The employee's manager: a reference to another Employee (self-reference).
  field "ReportsTo" {
    record = "Employee"
  }

  field "BirthDate" {
    type = "datetime"
  }

  field "HireDate" {
    type = "datetime"
  }

  field "Address" {
    type    = "string"
    max_len = 70
  }

  field "City" {
    type    = "string"
    max_len = 40
  }

  field "State" {
    type    = "string"
    max_len = 40
  }

  field "Country" {
    type    = "string"
    max_len = 40
  }

  field "PostalCode" {
    type    = "string"
    max_len = 10
  }

  field "Phone" {
    type    = "string"
    max_len = 24
  }

  field "Fax" {
    type    = "string"
    max_len = 24
  }

  field "Email" {
    type    = "string"
    max_len = 60
    format  = "email"
  }
}

# One sale: an invoice raised for a customer.
record "Invoice" {
  key = ["InvoiceId"]

  field "InvoiceId" {
    type     = "int"
    required = true
  }

  field "CustomerId" {
    record   = "Customer"
    required = true
  }

  field "InvoiceDate" {
    type     = "datetime"
    required = true
  }

  field "BillingAddress" {
    type    = "string"
    max_len = 70
  }

  field "BillingCity" {
    type    = "string"
    max_len = 40
  }

  field "BillingState" {
    type    = "string"
    max_len = 40
  }

  # Country name as Chinook spells it ("USA", "Czech Republic").
  field "BillingCountry" {
    type    = "string"
    max_len = 40
  }

  field "BillingPostalCode" {
    type    = "string"
    max_len = 10
  }

  # Amount charged. Equals the sum of UnitPrice x Quantity over the invoice's
  # lines. NUMERIC(10,2). The data names no currency.
  field "Total" {
    type     = "decimal"
    required = true
  }
}

# One track on an invoice.
record "InvoiceLine" {
  key = ["InvoiceLineId"]

  field "InvoiceLineId" {
    type     = "int"
    required = true
  }

  field "InvoiceId" {
    record   = "Invoice"
    required = true
  }

  field "TrackId" {
    record   = "Track"
    required = true
  }

  # Price charged for one copy on this invoice. NUMERIC(10,2).
  field "UnitPrice" {
    type     = "decimal"
    required = true
  }

  field "Quantity" {
    type     = "int"
    required = true
  }
}
