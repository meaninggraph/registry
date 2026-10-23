# Licence: MIT. Derived one-to-one from the pinned Northwind SQLite schema.
# ModelSpec 1.0-draft-2; OrderDetails represents the native SQLite table "Order Details" (ModelSpec published record type names must be identifiers).

record "Categories" {
  key = ["CategoryID"]

  field "CategoryID" {
    required = true
    type = "int"
  }

  field "CategoryName" {
    type = "string"
  }

  field "Description" {
    type = "string"
  }

  field "Picture" {
    type = "document"
  }
}

record "CustomerCustomerDemo" {
  key = ["CustomerID", "CustomerTypeID"]

  field "CustomerID" {
    required = true
    record = "Customers"
  }

  field "CustomerTypeID" {
    required = true
    record = "CustomerDemographics"
  }
}

record "CustomerDemographics" {
  key = ["CustomerTypeID"]

  field "CustomerTypeID" {
    required = true
    type = "string"
  }

  field "CustomerDesc" {
    type = "string"
  }
}

record "Customers" {
  key = ["CustomerID"]

  field "CustomerID" {
    required = true
    type = "string"
  }

  field "CompanyName" {
    type = "string"
  }

  field "ContactName" {
    type = "string"
  }

  field "ContactTitle" {
    type = "string"
  }

  field "Address" {
    type = "string"
  }

  field "City" {
    type = "string"
  }

  field "Region" {
    type = "string"
  }

  field "PostalCode" {
    type = "string"
  }

  field "Country" {
    type = "string"
  }

  field "Phone" {
    type = "string"
  }

  field "Fax" {
    type = "string"
  }
}

record "EmployeeTerritories" {
  key = ["EmployeeID", "TerritoryID"]

  field "EmployeeID" {
    required = true
    record = "Employees"
  }

  field "TerritoryID" {
    required = true
    record = "Territories"
  }
}

record "Employees" {
  key = ["EmployeeID"]

  field "EmployeeID" {
    required = true
    type = "int"
  }

  field "LastName" {
    type = "string"
  }

  field "FirstName" {
    type = "string"
  }

  field "Title" {
    type = "string"
  }

  field "TitleOfCourtesy" {
    type = "string"
  }

  field "BirthDate" {
    type = "date"
  }

  field "HireDate" {
    type = "date"
  }

  field "Address" {
    type = "string"
  }

  field "City" {
    type = "string"
  }

  field "Region" {
    type = "string"
  }

  field "PostalCode" {
    type = "string"
  }

  field "Country" {
    type = "string"
  }

  field "HomePhone" {
    type = "string"
  }

  field "Extension" {
    type = "string"
  }

  field "Photo" {
    type = "document"
  }

  field "Notes" {
    type = "string"
  }

  field "ReportsTo" {
    record = "Employees"
  }

  field "PhotoPath" {
    type = "string"
  }
}

record "OrderDetails" {
  key = ["OrderID", "ProductID"]

  field "OrderID" {
    required = true
    record = "Orders"
  }

  field "ProductID" {
    required = true
    record = "Products"
  }

  field "UnitPrice" {
    required = true
    type = "decimal"
  }

  field "Quantity" {
    required = true
    type = "int"
  }

  field "Discount" {
    required = true
    type = "decimal"
  }
}

record "Orders" {
  key = ["OrderID"]

  field "OrderID" {
    required = true
    type = "int"
  }

  field "CustomerID" {
    record = "Customers"
  }

  field "EmployeeID" {
    record = "Employees"
  }

  field "OrderDate" {
    type = "datetime"
  }

  field "RequiredDate" {
    type = "datetime"
  }

  field "ShippedDate" {
    type = "datetime"
  }

  field "ShipVia" {
    record = "Shippers"
  }

  field "Freight" {
    type = "decimal"
  }

  field "ShipName" {
    type = "string"
  }

  field "ShipAddress" {
    type = "string"
  }

  field "ShipCity" {
    type = "string"
  }

  field "ShipRegion" {
    type = "string"
  }

  field "ShipPostalCode" {
    type = "string"
  }

  field "ShipCountry" {
    type = "string"
  }
}

record "Products" {
  key = ["ProductID"]

  field "ProductID" {
    required = true
    type = "int"
  }

  field "ProductName" {
    required = true
    type = "string"
  }

  field "SupplierID" {
    record = "Suppliers"
  }

  field "CategoryID" {
    record = "Categories"
  }

  field "QuantityPerUnit" {
    type = "string"
  }

  field "UnitPrice" {
    type = "decimal"
  }

  field "UnitsInStock" {
    type = "int"
  }

  field "UnitsOnOrder" {
    type = "int"
  }

  field "ReorderLevel" {
    type = "int"
  }

  field "Discontinued" {
    required = true
    type = "string"
  }
}

record "Regions" {
  key = ["RegionID"]

  field "RegionID" {
    required = true
    type = "int"
  }

  field "RegionDescription" {
    required = true
    type = "string"
  }
}

record "Shippers" {
  key = ["ShipperID"]

  field "ShipperID" {
    required = true
    type = "int"
  }

  field "CompanyName" {
    required = true
    type = "string"
  }

  field "Phone" {
    type = "string"
  }
}

record "Suppliers" {
  key = ["SupplierID"]

  field "SupplierID" {
    required = true
    type = "int"
  }

  field "CompanyName" {
    required = true
    type = "string"
  }

  field "ContactName" {
    type = "string"
  }

  field "ContactTitle" {
    type = "string"
  }

  field "Address" {
    type = "string"
  }

  field "City" {
    type = "string"
  }

  field "Region" {
    type = "string"
  }

  field "PostalCode" {
    type = "string"
  }

  field "Country" {
    type = "string"
  }

  field "Phone" {
    type = "string"
  }

  field "Fax" {
    type = "string"
  }

  field "HomePage" {
    type = "string"
  }
}

record "Territories" {
  key = ["TerritoryID"]

  field "TerritoryID" {
    required = true
    type = "string"
  }

  field "TerritoryDescription" {
    required = true
    type = "string"
  }

  field "RegionID" {
    required = true
    record = "Regions"
  }
}
