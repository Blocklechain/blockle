// Autofill types a real person's home address into a stranger's web page.
//
// These tests RUN the generated script against a DOM stub (autofill_dom.js)
// rather than asserting on its source text. Checking that the string does not
// contain "submit(" proves almost nothing; the rules that matter are
// behavioural — a card field must survive untouched, the longest pattern must
// win, a quote in an address must not break out of the script — and
// behaviour has to be executed to be verified.

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:blockle_app/shop/delivery.dart';

const me = DeliveryProfile(
  fullName: 'Ada Lovelace',
  email: 'ada@example.com',
  phone: '+44 7700 900123',
  line1: '12 Dean Street',
  line2: 'Flat 4',
  city: 'London',
  region: 'Greater London',
  postcode: 'W1D 3RR',
  country: 'United Kingdom',
);

/// Run the real generated script over a stub DOM built from [fields].
Map<String, dynamic> fill(DeliveryProfile p, List<Map<String, dynamic>> fields) {
  final dir = Directory.systemTemp.createTempSync('autofill');
  final f = File('${dir.path}/s.js')..writeAsStringSync(Autofill.script(p));
  final res = Process.runSync(
      'node', ['test/shop/autofill_dom.js', f.path, jsonEncode(fields)]);
  dir.deleteSync(recursive: true);
  if (res.exitCode != 0) {
    fail('script failed to run:\n${res.stderr}');
  }
  return jsonDecode(res.stdout as String) as Map<String, dynamic>;
}

/// The value that ended up in the field with this name.
String valueOf(Map<String, dynamic> out, String name) => (out['filledValues']
        as List)
    .cast<Map<String, dynamic>>()
    .firstWhere((f) => f['name'] == name, orElse: () => {'value': '<missing>'})['value']
    .toString();

void main() {
  group('it fills the delivery fields', () {
    test('a plain checkout form', () {
      final out = fill(me, [
        {'name': 'email'},
        {'name': 'phone'},
        {'name': 'address1'},
        {'name': 'city'},
        {'name': 'zip'},
      ]);
      expect(valueOf(out, 'email'), 'ada@example.com');
      expect(valueOf(out, 'phone'), '+44 7700 900123');
      expect(valueOf(out, 'address1'), '12 Dean Street');
      expect(valueOf(out, 'city'), 'London');
      expect(valueOf(out, 'zip'), 'W1D 3RR');
      expect(out['result']['filled'], 5);
    });

    test('it prefers the autocomplete attribute, the standard one', () {
      // A real checkout whose input name is a meaningless generated id. The
      // standard attribute is the only thing that identifies it.
      final out = fill(me, [
        {'autocomplete': 'postal-code', 'name': 'f_8831'},
      ]);
      expect(valueOf(out, 'f_8831'), 'W1D 3RR');
    });

    test('address-line2 beats address — longest pattern wins', () {
      // 'address2' contains 'address'. Matching shortest-first would put the
      // street into the apartment box and leave the street empty.
      final out = fill(me, [
        {'name': 'address2'},
        {'name': 'address1'},
      ]);
      expect(valueOf(out, 'address2'), 'Flat 4');
      expect(valueOf(out, 'address1'), '12 Dean Street');
    });

    test('a split name form gets first and last separately', () {
      final out = fill(me, [
        {'name': 'first-name'},
        {'name': 'last-name'},
      ]);
      expect(valueOf(out, 'first-name'), 'Ada');
      expect(valueOf(out, 'last-name'), 'Lovelace');
    });

    test('it fires input AND change, or a React form submits empty', () {
      // Setting .value is invisible to React's value tracking; the field
      // looks filled and posts nothing.
      final out = fill(me, [
        {'name': 'city'}
      ]);
      final ev = ((out['filledValues'] as List).first
          as Map<String, dynamic>)['events'] as List;
      expect(ev, containsAll(<String>['input', 'change']));
    });

    test('a country dropdown is matched by option text', () {
      final out = fill(me, [
        {
          'tag': 'select',
          'type': 'select-one',
          'name': 'country',
          'options': ['France', 'United Kingdom', 'United States'],
        }
      ]);
      expect(valueOf(out, 'country'), 'United Kingdom');
    });
  });

  group('what it must never touch', () {
    test('a card number field is left alone', () {
      final out = fill(me, [
        {'name': 'cardnumber'},
        {'autocomplete': 'cc-number'},
        {'name': 'cvc'},
        {'name': 'card-expiry'},
      ]);
      for (final f in (out['filledValues'] as List).cast<Map>()) {
        expect(f['value'], '', reason: 'filled a payment field: ${f['name']}');
      }
      expect(out['result']['filled'], 0);
    });

    test('a password field is left alone even if named like an address', () {
      // type=password is an absolute veto, not a pattern.
      final out = fill(me, [
        {'name': 'address', 'type': 'password'},
      ]);
      expect(valueOf(out, 'address'), '');
    });

    test('a field that looks like BOTH an address and a card is skipped', () {
      // THE VETO IS CHECKED AFTER THE MATCH, deliberately. A merchant's
      // "card billing address" input matching 'address' must not be filled
      // just because the address pattern hit first.
      final out = fill(me, [
        {'name': 'cc-billing-address'},
      ]);
      expect(valueOf(out, 'cc-billing-address'), '');
    });

    test('seed phrase and private key fields are refused', () {
      // This browser also opens dApps. An autofill that types into a field
      // called "mnemonic" is a catastrophe, not an inconvenience.
      final out = fill(me, [
        {'name': 'mnemonic'},
        {'name': 'private-key'},
        {'name': 'account-number'},
      ]);
      expect(out['result']['filled'], 0);
    });

    test('IT NEVER SUBMITS', () {
      final out = fill(me, [
        {'name': 'email'},
        {'name': 'address1'},
        {'type': 'submit', 'name': 'place-order'},
      ]);
      expect(out['submitted'], isFalse);
      // And the submit button itself is not treated as a fillable field.
      expect(valueOf(out, 'place-order'), '');
    });

    test('hidden, disabled and readonly fields are skipped', () {
      final out = fill(me, [
        {'name': 'city', 'hidden': true},
        {'name': 'zip', 'disabled': true},
        {'name': 'email', 'readOnly': true},
      ]);
      expect(out['result']['filled'], 0);
    });
  });

  group('the user\'s own data is untrusted input', () {
    test('an apostrophe in an address does not break the script', () {
      const awkward = DeliveryProfile(line1: "12 O'Neill St", city: 'Cork');
      final out = fill(awkward, [
        {'name': 'address1'},
        {'name': 'city'},
      ]);
      expect(valueOf(out, 'address1'), "12 O'Neill St");
      expect(valueOf(out, 'city'), 'Cork');
    });

    test('a name containing script tags is data, never code', () {
      const hostile =
          DeliveryProfile(fullName: '</script><script>alert(1)</script>',
              line1: 'Somewhere');
      final out = fill(hostile, [
        {'name': 'fullname'},
        {'name': 'address1'},
      ]);
      // It lands verbatim in the field, and the rest of the form still fills
      // — i.e. the injection did not terminate the script.
      expect(valueOf(out, 'fullname'), '</script><script>alert(1)</script>');
      expect(valueOf(out, 'address1'), 'Somewhere');
    });

    test('backslashes and quotes survive intact', () {
      const odd = DeliveryProfile(line1: r'A\B "C" ', city: 'X');
      final out = fill(odd, [
        {'name': 'address1'}
      ]);
      expect(valueOf(out, 'address1'), r'A\B "C" ');
    });
  });

  group('an incomplete profile', () {
    test('empty fields are simply not filled, not blanked', () {
      const partial = DeliveryProfile(email: 'a@b.com');
      final out = fill(partial, [
        {'name': 'email'},
        {'name': 'address1'},
      ]);
      expect(valueOf(out, 'email'), 'a@b.com');
      expect(valueOf(out, 'address1'), '');
      expect(out['result']['filled'], 1);
    });

    test('it names what the shopper will still have to type', () {
      const partial = DeliveryProfile(fullName: 'Ada', email: 'a@b.com');
      expect(partial.missing, containsAll(['address', 'city', 'postcode']));
      expect(partial.missing, isNot(contains('name')));
    });

    test('an empty profile fills nothing at all', () {
      final out = fill(const DeliveryProfile(), [
        {'name': 'email'},
        {'name': 'address1'},
      ]);
      expect(out['result']['filled'], 0);
    });
  });

  group('name splitting', () {
    test('a single name has no surname rather than a duplicate', () {
      const p = DeliveryProfile(fullName: 'Prince');
      expect(p.firstName, 'Prince');
      expect(p.lastName, '');
    });

    test('a three-part name keeps the rest together', () {
      const p = DeliveryProfile(fullName: 'Ada King Lovelace');
      expect(p.firstName, 'Ada');
      expect(p.lastName, 'King Lovelace');
    });
  });
}
