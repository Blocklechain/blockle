import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:blockle_app/theme.dart';

void main() {
  testWidgets('themed Size.fromHeight is infinite-width (root cause)', (t) async {
    expect(const Size.fromHeight(52).width, double.infinity);
  });

  testWidgets('Allow button renders wide (no 1-char wrap) in a Row', (t) async {
    await t.pumpWidget(MaterialApp(
      theme: Bk.theme(), // the app theme with filledButtonTheme minimumSize Size.fromHeight(52)
      home: Scaffold(
        body: SizedBox(
          width: 360,
          child: Row(children: [
            const Expanded(child: Text('Bot notifications — get a banner when bots act')),
            const SizedBox(width: 12),
            FilledButton(
              style: FilledButton.styleFrom(
                backgroundColor: Bk.accent,
                minimumSize: const Size(72, 44),
                padding: const EdgeInsets.symmetric(horizontal: 18),
              ),
              onPressed: () {},
              child: const Text('Allow', maxLines: 1, softWrap: false),
            ),
          ]),
        ),
      ),
    ));
    final size = t.getSize(find.widgetWithText(FilledButton, 'Allow'));
    // A 1-char-per-line wrap makes the button ~20px wide; the fix keeps it >=72.
    expect(size.width, greaterThanOrEqualTo(72));
    // And the label occupies a single line (height ~ one text line within 44).
    expect(size.height, lessThanOrEqualTo(60));
  });
}
