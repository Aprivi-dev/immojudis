-- 20261108203000 : la règle d'adresse email de l'agent d'information (MÊME règle que
-- src/lib/information-agent/email-address.ts) et ses droits.
begin;

select plan(25);

select has_function(
  'app_private',
  'information_agent_email_is_valid',
  array['text'],
  'the email rule exists'
);
select ok(
  not has_function_privilege(
    'anon', 'app_private.information_agent_email_is_valid(text)', 'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated', 'app_private.information_agent_email_is_valid(text)', 'EXECUTE'
  )
  and has_function_privilege(
    'service_role', 'app_private.information_agent_email_is_valid(text)', 'EXECUTE'
  ),
  'only trusted server code calls the email rule'
);

-- Adresses acceptées (casse et espaces ignorés, comme normalizedEmail).
select ok(app_private.information_agent_email_is_valid('cabinet@example.test'), 'a plain address is valid');
select ok(app_private.information_agent_email_is_valid('  Cabinet.Dupont@Example.TEST '), 'case and spaces are ignored');
select ok(app_private.information_agent_email_is_valid('me+ventes@etude-martin.fr'), 'a plus tag is valid');
select ok(app_private.information_agent_email_is_valid('o''brien@cabinet.test'), 'an apostrophe is valid');
select ok(app_private.information_agent_email_is_valid('a@b.c.d.fr'), 'subdomains are valid');

-- Ce qui n'est pas une adresse : téléphone, nom, vide, adresse incomplète.
select ok(not app_private.information_agent_email_is_valid(null), 'null is not an address');
select ok(not app_private.information_agent_email_is_valid(''), 'an empty value is not an address');
select ok(not app_private.information_agent_email_is_valid('   '), 'spaces are not an address');
select ok(not app_private.information_agent_email_is_valid('05 56 00 00 01'), 'a phone number is not an address');
select ok(not app_private.information_agent_email_is_valid('+33 5 56 00 00 01'), 'an international phone number is not an address');
select ok(not app_private.information_agent_email_is_valid('Maître Jean Dupont'), 'a name is not an address');
select ok(not app_private.information_agent_email_is_valid('Me Dupont, avocat'), 'a name with a title is not an address');
select ok(not app_private.information_agent_email_is_valid('dupont@'), 'a missing domain is refused');
select ok(not app_private.information_agent_email_is_valid('dupont@cabinet'), 'a missing extension is refused');
select ok(not app_private.information_agent_email_is_valid('dupont@cabinet.f'), 'a one-letter extension is refused');
select ok(not app_private.information_agent_email_is_valid('a..b@cabinet.test'), 'consecutive dots are refused');
select ok(not app_private.information_agent_email_is_valid('.a@cabinet.test'), 'a leading dot is refused');
select ok(not app_private.information_agent_email_is_valid('a@-cabinet.test'), 'a domain label cannot start with a hyphen');
select ok(not app_private.information_agent_email_is_valid('Dupont <dupont@cabinet.test>'), 'an address in a display name is refused');
select ok(not app_private.information_agent_email_is_valid('a@cabinet.test b@cabinet.test'), 'two addresses are refused');
select ok(not app_private.information_agent_email_is_valid('dupont@cabinet.123'), 'a numeric extension is refused');
select ok(
  not app_private.information_agent_email_is_valid(repeat('a', 320) || '@cabinet.test'),
  'a value longer than 320 characters is refused'
);
select ok(
  app_private.information_agent_email_is_valid('a@b.fr')
  and not app_private.information_agent_email_is_valid('a@b'),
  'the shortest valid address passes, its truncation does not'
);

select * from finish();
rollback;
