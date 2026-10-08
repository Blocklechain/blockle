// Basic sanity test for the Blockle wallet app.
import 'package:flutter_test/flutter_test.dart';
import 'package:blockle_app/theme.dart';

void main() {
  test('theme builds', () {
    final t = Bk.theme();
    expect(t.scaffoldBackgroundColor, Bk.bg);
  });
}
