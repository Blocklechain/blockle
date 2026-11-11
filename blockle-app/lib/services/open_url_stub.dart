/// Native implementation — opens the URL in the app's own in-app browser tab
/// (the dApp browser), via a handler main.dart wires to AppState.openBrowser.
/// This was previously a NO-OP, which silently broke every "View on explorer"
/// button on iOS/Android. The web build overrides this file and opens a tab.
void Function(String url)? openExternalHandler;

void openExternal(String url) {
  final h = openExternalHandler;
  if (h != null) h(url);
}
