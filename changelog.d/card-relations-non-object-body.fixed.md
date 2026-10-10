Fixed: creating a card relation with a request body that is valid JSON but not an object (a bare number, string, array, `null`, or boolean) now returns 400 instead of 500 on PostgreSQL.
