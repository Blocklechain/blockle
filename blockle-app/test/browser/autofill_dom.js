// A minimal DOM, so the REAL autofill script can be executed in a test.
//
// Asserting on the generated JavaScript as a string would only prove the
// string contains certain characters. The rules that matter — never fill a
// card field, never submit, longest pattern wins — are behaviour, and
// behaviour has to be run. jsdom is not a dependency of this repo and is not
// worth adding for this, so the handful of DOM surfaces the script actually
// touches are stubbed here.
//
// Usage: node autofill_dom.js <scriptFile> <fieldsJson>
// Prints JSON: { result, filledValues, submitted }

const fs = require('fs');

const scriptFile = process.argv[2];
const fields = JSON.parse(process.argv[3]);

let submitted = false;

class Element {
  constructor(spec) {
    this.tagName = (spec.tag || 'input').toUpperCase();
    this.type = spec.type || 'text';
    this.disabled = !!spec.disabled;
    this.readOnly = !!spec.readOnly;
    // offsetParent null means "not visible"; the script skips those.
    this.offsetParent = spec.hidden ? null : {};
    this.value = '';
    this.events = [];
    this._attrs = {
      autocomplete: spec.autocomplete,
      name: spec.name,
      id: spec.id,
      placeholder: spec.placeholder,
      'aria-label': spec.ariaLabel,
    };
    if (spec.options) {
      this.options = spec.options.map((o) =>
        typeof o === 'string' ? { text: o, value: o } : o);
      this.selectedIndex = -1;
    }
  }
  getAttribute(k) {
    const v = this._attrs[k];
    return v === undefined ? null : v;
  }
  dispatchEvent(e) {
    this.events.push(e.type);
    return true;
  }
}

const nodes = fields.map((f) => new Element(f));

// The script reaches for these prototypes to defeat React's value tracking.
global.HTMLInputElement = Element;
global.HTMLTextAreaElement = class extends Element {};
global.Event = class {
  constructor(type) {
    this.type = type;
  }
};
global.document = {
  querySelectorAll: () => nodes,
  // Present so that a script calling it would be detected rather than
  // silently throwing — see the never-submits test.
  forms: [{ submit: () => { submitted = true; } }],
};

const src = fs.readFileSync(scriptFile, 'utf8');
// The generated source is an IIFE whose value we want.
const result = eval(src);

console.log(JSON.stringify({
  result: JSON.parse(result),
  filledValues: nodes.map((n) => ({
    name: n._attrs.name || n._attrs.autocomplete || n._attrs.id,
    value: n.tagName === 'SELECT'
      ? (n.selectedIndex >= 0 ? n.options[n.selectedIndex].value : '')
      : n.value,
    events: n.events,
  })),
  submitted,
}));
