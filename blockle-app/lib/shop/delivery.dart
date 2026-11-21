// The delivery details, and the rules for putting them into someone's
// checkout form.
//
// WHY A WHOLE FILE FOR "TYPE THE ADDRESS FOR ME". Autofill touches the user's
// real name, home address, email and phone, and it operates by injecting
// script into a third-party page. That combination deserves rules that are
// written down and tested, not a regex typed into a webview callback.
//
// THE FOUR RULES, each enforced in code below and covered by a test:
//
//   1. IT NEVER SUBMITS. The generated script fills inputs and dispatches the
//      events a React/Vue form needs to notice, and then stops. A shopper
//      must see what was filled, in their own browser, before anything is
//      sent to a shop. An autofill that submits is an autofill that can place
//      an order the user never reviewed.
//
//   2. IT NEVER TOUCHES PAYMENT OR PASSWORD FIELDS. Card number, expiry, CVC,
//      and anything of type=password are refused even if a page labels them
//      as something else. Blockle does not hold card details and must not be
//      the thing that types them.
//
//   3. IT ONLY RUNS WHEN THE USER ASKS. There is no load hook here. The user
//      taps "Fill my details" on the page they are looking at.
//
//   4. EVERY VALUE IS JSON-ENCODED INTO THE SCRIPT. An address line
//      containing an apostrophe — or `</script>` — would otherwise break the
//      injection or execute as code. The user's own data is still untrusted
//      input to a code generator.

import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Where an order goes.
///
/// Every field is optional and an empty one is simply not filled, because a
/// half-complete profile is normal and much better than refusing to help at
/// all.
class DeliveryProfile {
  const DeliveryProfile({
    this.fullName = '',
    this.email = '',
    this.phone = '',
    this.line1 = '',
    this.line2 = '',
    this.city = '',
    this.region = '',
    this.postcode = '',
    this.country = '',
  });

  final String fullName;
  final String email;
  final String phone;
  final String line1;
  final String line2;
  final String city;

  /// State / province / county.
  final String region;
  final String postcode;
  final String country;

  bool get isEmpty =>
      [fullName, email, phone, line1, line2, city, region, postcode, country]
          .every((v) => v.trim().isEmpty);

  /// What a shopper would still have to type themselves. Shown before filling
  /// so there are no surprises halfway down a checkout page.
  List<String> get missing => [
        if (fullName.trim().isEmpty) 'name',
        if (line1.trim().isEmpty) 'address',
        if (city.trim().isEmpty) 'city',
        if (postcode.trim().isEmpty) 'postcode',
        if (country.trim().isEmpty) 'country',
      ];

  String get firstName => fullName.trim().split(RegExp(r'\s+')).first;

  String get lastName {
    final parts = fullName.trim().split(RegExp(r'\s+'));
    return parts.length > 1 ? parts.sublist(1).join(' ') : '';
  }

  /// One line, for confirming what is about to be filled.
  String get summary => [line1, line2, city, region, postcode, country]
      .where((v) => v.trim().isNotEmpty)
      .join(', ');

  DeliveryProfile copyWith({
    String? fullName,
    String? email,
    String? phone,
    String? line1,
    String? line2,
    String? city,
    String? region,
    String? postcode,
    String? country,
  }) =>
      DeliveryProfile(
        fullName: fullName ?? this.fullName,
        email: email ?? this.email,
        phone: phone ?? this.phone,
        line1: line1 ?? this.line1,
        line2: line2 ?? this.line2,
        city: city ?? this.city,
        region: region ?? this.region,
        postcode: postcode ?? this.postcode,
        country: country ?? this.country,
      );

  Map<String, dynamic> toJson() => {
        'fullName': fullName,
        'email': email,
        'phone': phone,
        'line1': line1,
        'line2': line2,
        'city': city,
        'region': region,
        'postcode': postcode,
        'country': country,
      };

  static DeliveryProfile fromJson(Map<String, dynamic> j) => DeliveryProfile(
        fullName: '${j['fullName'] ?? ''}',
        email: '${j['email'] ?? ''}',
        phone: '${j['phone'] ?? ''}',
        line1: '${j['line1'] ?? ''}',
        line2: '${j['line2'] ?? ''}',
        city: '${j['city'] ?? ''}',
        region: '${j['region'] ?? ''}',
        postcode: '${j['postcode'] ?? ''}',
        country: '${j['country'] ?? ''}',
      );
}

/// The saved profile.
///
/// Secure storage, not SharedPreferences: this is a home address, and it gets
/// the Keychain / Keystore the same as everything else sensitive in the app.
class DeliveryBook extends ChangeNotifier {
  DeliveryBook({FlutterSecureStorage? store})
      : _store = store ?? const FlutterSecureStorage();

  static const _key = 'blockle_delivery_v1';
  final FlutterSecureStorage _store;

  DeliveryProfile profile = const DeliveryProfile();

  Future<void> load() async {
    try {
      final raw = await _store.read(key: _key);
      if (raw == null) return;
      final j = jsonDecode(raw);
      if (j is Map<String, dynamic>) {
        profile = DeliveryProfile.fromJson(j);
        notifyListeners();
      }
    } catch (_) {}
  }

  Future<void> save(DeliveryProfile p) async {
    profile = p;
    notifyListeners();
    try {
      await _store.write(key: _key, value: jsonEncode(p.toJson()));
    } catch (_) {}
  }

  Future<void> clear() async {
    profile = const DeliveryProfile();
    notifyListeners();
    try {
      await _store.delete(key: _key);
    } catch (_) {}
  }
}

/// Builds the script that fills a checkout form.
///
/// Kept as a pure function returning a string so the rules above can be
/// tested without a webview. The generated script is defensive on the page
/// side too: it counts what it filled and reports back, so the UI can say
/// "filled 6 fields" rather than claiming success into the void.
class Autofill {
  /// Field name/id/autocomplete fragments we will fill, in priority order.
  ///
  /// Matched against the autocomplete attribute first because that is the
  /// standard and is unambiguous; name/id/placeholder are the fallback for
  /// the many checkouts that do not set it.
  static const Map<String, List<String>> patterns = {
    'fullName': ['name', 'fullname', 'full-name', 'your-name', 'recipient'],
    'firstName': ['given-name', 'firstname', 'first-name', 'fname'],
    'lastName': ['family-name', 'lastname', 'last-name', 'lname', 'surname'],
    'email': ['email', 'e-mail'],
    'phone': ['tel', 'phone', 'mobile', 'telephone'],
    'line1': [
      'address-line1',
      'street-address',
      'address1',
      'addressline1',
      'street',
      'address',
    ],
    'line2': ['address-line2', 'address2', 'addressline2', 'apartment', 'apt'],
    'city': ['address-level2', 'city', 'town', 'locality'],
    'region': ['address-level1', 'state', 'province', 'region', 'county'],
    'postcode': ['postal-code', 'postcode', 'zip', 'zipcode', 'postal'],
    'country': ['country-name', 'country'],
  };

  /// NEVER FILLED, whatever a page calls them.
  ///
  /// A checkout page that labels its card field `name="address"` would
  /// otherwise receive a street address in the card box — but far worse, a
  /// page whose address field is near a card field must not tempt this code
  /// into "helpfully" completing payment. Checked as a veto AFTER a match, so
  /// a suspicious field is skipped rather than filled by a lucky pattern.
  static const List<String> forbidden = [
    'cc-',
    'card',
    'cardnumber',
    'creditcard',
    'cvc',
    'cvv',
    'csc',
    'security-code',
    'securitycode',
    'expiry',
    'exp-date',
    'expiration',
    'password',
    'passwd',
    'pin',
    'ssn',
    'social-security',
    'routing',
    'iban',
    'account-number',
    'accountnumber',
    'seed',
    'mnemonic',
    'private-key',
    'privatekey',
  ];

  /// The values to try, keyed by the pattern group.
  static Map<String, String> valuesFor(DeliveryProfile p) => {
        'fullName': p.fullName,
        'firstName': p.firstName,
        'lastName': p.lastName,
        'email': p.email,
        'phone': p.phone,
        'line1': p.line1,
        'line2': p.line2,
        'city': p.city,
        'region': p.region,
        'postcode': p.postcode,
        'country': p.country,
      }..removeWhere((_, v) => v.trim().isEmpty);

  /// The injectable script.
  ///
  /// Returns a JSON string on the page side: {"filled": n, "fields": [...]}.
  static String script(DeliveryProfile profile) {
    // EVERY value goes through jsonEncode. An address of
    // `12 O'Neill St` or a name containing `</script>` is ordinary user data
    // and must not be able to break out of the string it lives in.
    final values = jsonEncode(valuesFor(profile));
    final pats = jsonEncode(patterns);
    final bad = jsonEncode(forbidden);

    return '''
(function () {
  var VALUES = $values;
  var PATTERNS = $pats;
  var FORBIDDEN = $bad;

  function haystack(el) {
    return [
      el.getAttribute('autocomplete'),
      el.getAttribute('name'),
      el.getAttribute('id'),
      el.getAttribute('placeholder'),
      el.getAttribute('aria-label')
    ].filter(Boolean).join(' ').toLowerCase();
  }

  // A veto, not a filter: checked after a pattern matches, so a field that
  // looks like an address AND like a card is skipped rather than filled.
  function forbidden(el, hay) {
    if ((el.type || '').toLowerCase() === 'password') return true;
    for (var i = 0; i < FORBIDDEN.length; i++) {
      if (hay.indexOf(FORBIDDEN[i]) !== -1) return true;
    }
    return false;
  }

  function setValue(el, v) {
    // Assigning .value alone is invisible to React, which tracks the value
    // on the element's prototype descriptor. Without this a filled field
    // looks right and submits empty.
    var proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    var setter = Object.getOwnPropertyDescriptor(proto, 'value');
    if (setter && setter.set) { setter.set.call(el, v); } else { el.value = v; }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  var filled = [];
  var used = {};
  var nodes = document.querySelectorAll('input, textarea, select');

  // Longest pattern first so 'address-line2' wins over 'address'.
  var keys = Object.keys(PATTERNS);
  var pairs = [];
  for (var k = 0; k < keys.length; k++) {
    var ps = PATTERNS[keys[k]];
    for (var m = 0; m < ps.length; m++) pairs.push([keys[k], ps[m]]);
  }
  pairs.sort(function (a, b) { return b[1].length - a[1].length; });

  for (var n = 0; n < nodes.length; n++) {
    var el = nodes[n];
    if (el.disabled || el.readOnly) continue;
    if (el.type === 'hidden' || el.type === 'submit' || el.type === 'button') continue;
    if (el.offsetParent === null && el.type !== 'select-one') continue;
    var hay = haystack(el);
    if (!hay) continue;
    for (var q = 0; q < pairs.length; q++) {
      var key = pairs[q][0], pat = pairs[q][1];
      if (used[key]) continue;
      if (hay.indexOf(pat) === -1) continue;
      if (forbidden(el, hay)) break;
      var v = VALUES[key];
      if (!v) break;
      if (el.tagName === 'SELECT') {
        var hit = false;
        for (var o = 0; o < el.options.length; o++) {
          var ot = (el.options[o].text || '') + ' ' + (el.options[o].value || '');
          if (ot.toLowerCase().indexOf(v.toLowerCase()) !== -1) {
            el.selectedIndex = o;
            el.dispatchEvent(new Event('change', { bubbles: true }));
            hit = true;
            break;
          }
        }
        if (!hit) break;
      } else {
        setValue(el, v);
      }
      used[key] = true;
      filled.push(key);
      break;
    }
  }

  // AND THAT IS ALL. No form.submit(), no clicking a pay button. The user
  // reviews and submits the order themselves.
  return JSON.stringify({ filled: filled.length, fields: filled });
})();
''';
  }
}
