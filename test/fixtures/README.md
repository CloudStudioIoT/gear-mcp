# Fixtures

Responses in the exact shape Gear returns them (wrapped `...Result` bodies and `/Date(...)/` dates for
the Service API, plain arrays and `yyyy-MM-ddTHH:mm:ss` for REST v2), with invented data.

- `error-8001.json` is **recorded from a Gear development instance**, byte for byte.
- The data responses follow what a Gear 1.9.5 instance returns (`Facility`, `Device`, `DeviceData`,
  `GearAPI_EndpointData`, `GearAPI_Alarm`), with the values invented. To refresh them, run the server against
  a test instance with a token and save the raw responses here with client names removed.

Shapes worth knowing, all reproduced here:

- `EnumDevices` carries no last-data date. An endpoint's `LastStatusDateTime` is a `{Date, Time}` object in UTC,
  and a live endpoint is flat (`EndpointID`, `Description`, `NumericValue`, `ValueString`).
- In `GetDeviceLiveData`, `LastUpdate` is display text in the facility's date format and time zone, not a date;
  a battery comes with `Percentage` 0 next to a real voltage (3.15 V) when Gear has no percentage for it; and a
  `ValueString` can end in a space (`"Vacant "`).
