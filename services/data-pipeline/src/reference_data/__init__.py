"""Official reference data shown on a listing page.

* ``communes``: commune list from geo.api.gouv.fr (INSEE code, postal codes, centre);
* ``risks``: GASPAR base from Géorisques (DDRM risks, CatNat decrees, prevention plans);
* ``climate``: Météo-France monthly climatological data per station.

Everything is downloaded in bulk by the manual "Reference data import" workflow
and stored in Supabase, so the web application reads local tables instead of
calling a third-party service while a visitor is waiting.
"""
