/**
 * The generic application-form engine, ported from job-apply-ai-mvp
 * (extension/src/content/content.ts): reads any job application form
 * (company career sites, ATSs like Greenhouse, Lever, Workday, and
 * job-board apply modals), fills it, and finds Apply / Next / Submit.
 *
 * Not a manifest content script: the service worker injects it with
 * chrome.scripting into the tab the agent opened (all frames), and
 * drives it with messages from src/shared/ai-apply/flow.ts. It never
 * acts on its own.
 */
type Field = {
  id: string;
  label: string;
  type: string;
  required: boolean;
  options: string[];
  current_value: string;
  group_name?: string;
  group_label?: string;

  // Set when this field lives inside a block created by
  // prepareRepeatableSection() (a "+ Add"-driven Work Experience
  // panel, e.g. Workday's) — entry_index (0 = most recent) is which
  // profile.experience entry the field's block corresponds to.
  entry_type?: string;
  entry_index?: number;

  // What the input-type agent (src/shared/ai-apply/input-kinds.ts) needs to shape an answer for this control.
  min?: string;
  max?: string;
  step?: string;
  placeholder?: string;
  max_length?: string;
  has_code_picker?: boolean;
};

// Shared with prepareRepeatableSection()'s "is this section already
// populated" check, so both see the same definition of "a fillable
// field."
import { handleWorkdayMessage } from './ats/workday';
import { handleZohoMessage } from './ats/zoho';
import { handleKekaMessage } from './ats/keka';
import { handleIndeedMessage } from './ats/indeed';
import { accountStep, watchAfterPress } from './account';
import { isSideFormContext, pickClearApplyCandidate, scoreApplyCandidate, type ApplyCandidate } from '../shared/ai-apply/apply-button';
import { naukriApplied, naukriChatFill, naukriChatForm, naukriChatRoot, naukriChatSave } from './naukri-chat';

/**
 * The site's own navigation and job-search bar, never part of an application form. Naukri's search bar (keyword,
 * experience, location) is a plain div, `#ni-gnb-searchbar` in `.nI-gNb-search-bar` (seen live 2026-11-04); read
 * as a form, it made AI apply skip the Apply button and "fill" the search instead.
 */
const SITE_CHROME_SELECTOR =
  "nav, header, [role='navigation'], [role='banner'], [role='search'], " +
  "[id*='searchbar' i], [class*='searchbar' i], [class*='search-bar' i], .nI-gNb-header__wrapper, " +
  // Site language pickers ("Change Site Language" on Oracle Candidate Experience).
  "[aria-label*='site language' i], [class*='language-selector' i], [class*='language-switch' i], " +
  // Indeed's job search on a job page ("What" / "Where", data-testid standalone-desktop-search-form, 2026-11-05):
  // read as the form, it made AI apply fill the search and stop with "no Next or Submit" on every Indeed job.
  "[data-testid*='search-form' i], [data-testid*='desktop-search' i], [class*='desktop-search' i]";

const GREENHOUSE_EMPLOYMENT_ID =
  /^(?:company-name|title|start-date-month|start-date-year|end-date-month|end-date-year|current-role)-(\d+)(?:_\d+)?$/;

const FORM_FIELD_SELECTOR = [
  "input:not([type='hidden'])",
  "textarea",
  "select",
  "[role='textbox']",
  "[role='combobox']",
  "[aria-haspopup='listbox']",
  "[aria-haspopup='menu']",
  "[aria-haspopup='true']",
  "[role='radio']",
  "[role='checkbox']",
  "[role='listbox']",
  // The input-type agent's controls: toggle switches, sliders and rating scales, spin buttons, signature pads.
  "[role='switch']",
  "[role='slider']",
  "[role='spinbutton']",
  "canvas"
].join(",");

function textOf(el: Element | null): string {
  return (el?.textContent || "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeText(value: string): string {
  // Accents dropped first: "Karnātaka" (some ATS) is "Karnataka".
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// Plain substring matching (`"female".includes("male")`,
// `"british indian ocean territory".includes("india")` via
// "ind-IA-n") silently matches the WRONG option whenever one
// option's text happens to contain another's as a run of
// characters — confirmed live: gender "Male" matched onto
// "Female", country "India" matched onto "British Indian Ocean
// Territory", both because the wrong option simply came first in
// DOM order. Require the shorter string to appear as a whole
// word/phrase (bounded by non-alphanumeric characters or string
// edges) in the longer one instead of an arbitrary substring.
function containsWholeWord(
  haystack: string,
  needle: string
): boolean {
  if (!needle) {
    return false;
  }
  const escaped = needle.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );
  return new RegExp(
    `(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`
  ).test(haystack);
}

function fuzzyTextMatch(a: string, b: string): boolean {
  return (
    a === b ||
    containsWholeWord(a, b) ||
    containsWholeWord(b, a)
  );
}

// ---------------------------------------------------------------
// Shadow DOM support. LinkedIn's Easy
// Apply modal (confirmed live) renders
// entirely inside an open shadow root
// (host <div id="interop-outlet">), not
// the light DOM — document.querySelector
// / getElementById never see into a
// shadow root, so every "find a related
// element" helper below needs to search
// within the SAME root the element
// actually belongs to, and every
// "discover all candidate elements on
// the page" call needs to walk into
// nested shadow roots explicitly.
// ---------------------------------------------------------------

/**
 * The Document or ShadowRoot an element
 * actually lives in — use this instead
 * of the bare `document` whenever
 * looking up something related to a
 * specific element (its label, its
 * radio/checkbox siblings by name,
 * etc.), so the lookup stays inside
 * whichever shadow root that element is
 * in.
 */
function ownerRoot(
  el: Element
): Document | ShadowRoot {

  const root = el.getRootNode();

  return root instanceof ShadowRoot ||
    root instanceof Document
    ? root
    : document;
}

/**
 * querySelectorAll that also descends
 * into every open shadow root under
 * `root`, so page-wide discovery (form
 * fields, buttons, option popups) finds
 * elements a modal renders inside a
 * shadow tree.
 */
function queryAllDeep(
  selector: string,
  root: ParentNode = document
): HTMLElement[] {

  const direct =
    Array.from(
      root.querySelectorAll<HTMLElement>(
        selector
      )
    );

  const hosts =
    root.querySelectorAll<HTMLElement>(
      "*"
    );

  const nested: HTMLElement[] = [];

  hosts.forEach(candidate => {

    if (candidate.shadowRoot) {

      nested.push(
        ...queryAllDeep(
          selector,
          candidate.shadowRoot
        )
      );
    }
  });

  return direct.concat(nested);
}

/**
 * getElementById that also descends
 * into open shadow roots.
 */
function getElementByIdDeep(
  id: string,
  root: Document | ShadowRoot = document
): HTMLElement | null {

  const direct =
    root.getElementById(id);

  if (direct) {
    return direct;
  }

  const hosts =
    root.querySelectorAll<HTMLElement>(
      "*"
    );

  for (
    const candidate of
      Array.from(hosts)
  ) {

    if (candidate.shadowRoot) {

      const found =
        getElementByIdDeep(
          id,
          candidate.shadowRoot
        );

      if (found) {
        return found;
      }
    }
  }

  return null;
}

// A page's own `id` attribute is only safe to reuse as a field
// identifier if it's actually unique — confirmed live as the root
// cause of one field's answer landing on a completely unrelated
// field (a phone number appearing as the answer to an open-ended
// "describe the team you managed" question): two different form
// controls shared the same duplicated `id` (invalid HTML, but real
// ATS-generated forms do this), so both ended up as separate
// FormField entries with an IDENTICAL id — every downstream
// id-keyed lookup (the answer map, findElement's getElementById
// fallback) then collapsed or resolved to just one of them.
function hasUniqueId(el: HTMLElement): boolean {
  const doc = el.ownerDocument;

  if (!doc || !el.id) {
    return false;
  }

  return (
    queryAllDeep(
      `[id="${cssString(el.id)}"]`,
      doc
    ).length === 1
  );
}

function ensureId(
  el: HTMLElement,
  index: number
): string {
  if (el.id && hasUniqueId(el)) return el.id;

  // A repeat call on the same element
  // (e.g. a shared group container
  // visited once per leaf option inside
  // it) must return the SAME id it
  // already assigned, not mint a new one
  // — confirmed live as the reason a
  // Google Forms radio-group question
  // was extracted three times over
  // (once per option) instead of once:
  // only `.id` was checked for an
  // existing value, never the
  // `data-jobai-id` attribute this
  // function itself sets, so every call
  // regenerated and overwrote it.
  const existing =
    el.getAttribute("data-jobai-id");

  if (existing) return existing;

  const id =
    `jobai_${index}_${Math.random()
      .toString(36)
      .slice(2, 8)}`;

  el.setAttribute(
    "data-jobai-id",
    id
  );

  return id;
}

// A handful of ATS platforms (confirmed live: every single custom
// question on Lever's application form) put the SAME boilerplate
// hint text in every field's `placeholder` — "Type your response"
// on Lever, regardless of what the field is actually asking. The
// real question text lives in a sibling label div instead (Lever:
// ".application-label" next to ".application-field"). Because
// getLabel() checked placeholder before ever trying nearby sibling
// text, EVERY custom question on a Lever form — "Total Years of
// Experience", "Relevant Experience in Product", etc. — was
// reported to the LLM under the identical meaningless label "Type
// your response", indistinguishable from one another. That's the
// confirmed root cause of a "Total Years of Experience" field
// getting a nonsense answer ("No") — the model had no way to know
// which question it was actually answering.
function isGenericPlaceholder(
  value: string
): boolean {

  const normalized =
    value
      .trim()
      .toLowerCase()
      .replace(/[.…]+$/, "");

  const genericPhrases = [
    "type your response",
    "type your answer",
    "enter your answer",
    "your answer",
    "type here",
    "enter text",
    "enter your response",
    "please specify",
    "type your message",
    "your response"
  ];

  return genericPhrases.includes(normalized);
}

// Many custom-built career/ATS pages never use a semantic <label>
// (no `for`, no aria-label/aria-labelledby, no wrapping <label>) —
// the "question text" is just a plain sibling <div>/<span>/<p>
// sitting next to the input, tied to it only by CSS layout. Without
// this fallback, getLabel() returned "" for a genuinely visible,
// fillable field, and every field-type branch below drops any
// field with no label entirely — confirmed live as the reason a
// whole page could extract to zero fields (and the agent giving up
// with "Could not find an application form") even though a person
// looking at the same page could clearly see and fill it in.
function nearbyLabelText(
  el: HTMLElement
): string {

  let node: HTMLElement | null = el;

  for (
    let depth = 0;
    depth < 3 && node;
    depth++
  ) {

    const prev =
      node.previousElementSibling as
        HTMLElement | null;

    if (prev && isRendered(prev)) {

      const text =
        textOf(prev).trim();

      // A real label reads short — a long
      // previous sibling is more likely
      // unrelated page content (an entire
      // preceding question's answer
      // block, a paragraph of
      // instructions) rather than this
      // field's own label.
      if (text && text.length <= 120) {
        return text;
      }
    }

    node = node.parentElement;
  }

  return "";
}

// A last-resort fallback below even nearbyLabelText/placeholder —
// a form control's own `name` attribute is developer-facing, not
// written for a human to read, but a prettified version of it
// ("team_size" -> "team size") is still a far better signal than no
// label at all for a genuinely rendered, fillable field.
function prettifiedNameLabel(
  el: HTMLElement
): string {

  const name =
    el.getAttribute("name");

  if (!name) {
    return "";
  }

  return name
    .replace(/[_\-]+/g, " ")
    .replace(
      /([a-z])([A-Z])/g,
      "$1 $2"
    )
    .trim();
}

/**
 * The text of a <label> that wraps its field, without the part of
 * the label that holds the field itself. Lever wraps the question and
 * the whole field container (location dropdown's "No location found",
 * the resume uploader's "Analyzing resume...") in one <label>, so its
 * full text made "Current location No location found ..." — too long
 * to match the profile's location. Falls back to the whole label.
 */
function wrappingLabelText(
  label: HTMLElement,
  el: HTMLElement
): string {
  const own = [...label.childNodes]
    .filter(node => node !== el && !(node instanceof Element && node.contains(el)))
    .map(node => node.textContent || "")
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  return own || textOf(label);
}

function getLabel(el: HTMLElement): string {
  const id = el.getAttribute("id");

  if (id) {
    const label =
      ownerRoot(el).querySelector(
        `label[for="${cssString(id)}"]`
      );

    if (label) {
      return textOf(label);
    }
  }

  const aria =
    el.getAttribute("aria-label");

  if (aria) {
    return aria.trim();
  }

  const labelledBy =
    el.getAttribute("aria-labelledby");

  if (labelledBy) {
    const text =
      labelledBy
        .split(/\s+/)
        .map(id =>
          textOf(
            ownerRoot(el).getElementById(
              id
            )
          )
        )
        .filter(Boolean)
        .join(" ");

    if (text) return text;
  }

  const parentLabel =
    el.closest("label");

  if (parentLabel) {
    return wrappingLabelText(parentLabel, el);
  }

  const placeholder =
    el.getAttribute("placeholder");

  if (placeholder && !isGenericPlaceholder(placeholder)) {
    return placeholder;
  }

  const nearby =
    nearbyLabelText(el);

  if (nearby) {
    return nearby;
  }

  return prettifiedNameLabel(el);
}

function getInputLabel(
  input: HTMLInputElement
): string {
  return getLabel(input);
}

function getGroupLabel(
  el: HTMLElement
): string {

  // fieldset / legend
  const fieldset =
    el.closest("fieldset");

  if (fieldset) {
    const legend =
      fieldset.querySelector("legend");

    if (legend) {
      return textOf(legend);
    }
  }

  // aria-labelledby
  const labelledBy =
    el.getAttribute(
      "aria-labelledby"
    );

  if (labelledBy) {
    const result =
      labelledBy
        .split(/\s+/)
        .map(id =>
          textOf(
            ownerRoot(el).getElementById(
              id
            )
          )
        )
        .filter(Boolean)
        .join(" ");

    if (result) {
      return result;
    }
  }

  // Search nearby heading / label
  let parent =
    el.parentElement;

  for (
    let i = 0;
    i < 4 && parent;
    i++
  ) {

    const heading =
      parent.querySelector(
        "legend, h1, h2, h3, h4, h5, h6, [role='heading']"
      );

    if (heading) {
      return textOf(heading);
    }

    parent =
      parent.parentElement;
  }

  // The question as a plain text block just before the options, with
  // no legend or heading: Lever's custom questions
  // (div.application-label > div.text, then ul[data-qa=multiple-choice])
  // and many hand-built career-site forms. Without this the group was
  // labelled with its first option ("Yes – I confirm …"), which the
  // LLM and form memory could not match. Found by the golden form set
  // (tests/fixtures/forms/).
  let node: HTMLElement | null = el;

  for (let depth = 0; depth < 6 && node; depth++) {
    let sibling = node.previousElementSibling;

    while (sibling) {
      const text = textOf(sibling);

      if (
        text.length > 2 &&
        !sibling.querySelector("input, select, textarea")
      ) {
        return text;
      }

      sibling = sibling.previousElementSibling;
    }

    node = node.parentElement;
  }

  return "";
}

function getOptionsForGroup(
  el: HTMLInputElement
): string[] {

  const type =
    el.type;

  const name =
    el.getAttribute("name");

  if (!name) {
    return [];
  }

  const inputs =
    Array.from(
      ownerRoot(el).querySelectorAll<HTMLInputElement>(
        `input[type="${cssString(type)}"][name="${cssString(name)}"]`
      )
    );

  return inputs
    .map(input =>
      getInputLabel(input) ||
      input.value
    )
    .filter(Boolean);
}

function getSelectOptions(
  el: HTMLSelectElement
): string[] {

  return Array.from(
    el.options
  )
    .map(option =>
      option.text.trim()
    )
    .filter(Boolean);
}

// A native <select> with no explicit
// `selected` option still reports a
// non-empty .selectedOptions — the
// browser auto-selects the first
// option in the list, which sites
// almost always use as an unpicked
// placeholder ("Select an option",
// "N/A", "None selected", etc, in
// whatever wording the site chose).
// isPlaceholderValue()'s wording-based
// check only catches a few known
// phrasings, so a placeholder worded
// differently (e.g. "N/A") slipped
// through, made isAlreadyFilled()
// wrongly report the field as already
// answered, and the field was silently
// skipped forever — the field's own
// disabled-first-option markup is a
// far more reliable signal than
// guessing from the label text.
function selectCurrentValue(
  el: HTMLSelectElement
): string {

  // For a single select, the option at selectedIndex: the same thing
  // selectedOptions gives in Chrome, and also right where an engine
  // keeps selectedOptions on the HTML's own selected="selected" (the
  // golden form tests saw Okta's Gender stay "Choose").
  const selected = el.multiple
    ? Array.from(el.selectedOptions)
    : [el.options[el.selectedIndex]].filter(
        (option): option is HTMLOptionElement => !!option
      );

  const isUnpickedPlaceholder =
    el.selectedIndex === 0 &&
    (
      el.value === "" ||
      el.options[el.selectedIndex]
        ?.disabled === true
    );

  if (isUnpickedPlaceholder) {
    return "";
  }

  return selected
    .map(option => option.text.trim())
    .join(", ");
}

function isCustomCombobox(
  el: HTMLElement
): boolean {

  const haspopup =
    el.getAttribute(
      "aria-haspopup"
    );

  // Only option-list-shaped popups.
  // aria-haspopup="dialog" (e.g. a
  // date picker's calendar button) is
  // a different widget entirely —
  // clicking it to "harvest options"
  // opens a modal-like dialog instead
  // of a list, which can leave the
  // page stuck with an open overlay.
  return (
    el.getAttribute("role") ===
      "combobox" ||
    // Google Forms' single-select
    // dropdown question IS the
    // role="listbox" element itself
    // (its options are pre-mounted at
    // zero height until clicked open,
    // not a separate popup a trigger
    // button reveals) — confirmed live.
    el.getAttribute("role") ===
      "listbox" ||
    (
      [
        "listbox",
        "menu",
        "true"
      ].includes(haspopup || "")
    )
  );
}

/**
 * Dispatch a click that mouse-event
 * gated widgets will actually accept.
 *
 * HTMLElement.click() synthesizes a
 * MouseEvent with detail: 0. Some
 * component libraries (observed on
 * BambooHR's dropdown widget) only
 * treat a click as "real" when
 * detail >= 1, which is what every
 * genuine user click carries — so a
 * plain .click() silently no-ops on
 * those triggers.
 */
function simulateClick(
  el: HTMLElement
): void {

  // Some widgets (Google Forms'
  // dropdown options chief among them
  // — confirmed live) hit-test the
  // click's screen coordinates against
  // whatever's actually there, rather
  // than trusting the event target
  // directly. A synthetic click on an
  // element that happens to be
  // scrolled outside the viewport
  // computes an off-screen clientX/
  // clientY that hit-testing finds
  // nothing at, so the click is
  // silently ignored even though it
  // reached the right DOM node and
  // every event fired normally.
  // Scrolling into view first — with
  // "auto", not "smooth", so layout
  // updates synchronously in this same
  // call rather than over a later
  // animation frame — keeps the
  // computed coordinates accurate
  // regardless of where the element
  // happened to be when addressed. A
  // no-op, and harmless, when it was
  // already in view.
  el.scrollIntoView({
    block: "center",
    inline: "nearest",
    behavior: "auto"
  });

  const rect =
    el.getBoundingClientRect();

  const point = {
    bubbles: true,
    cancelable: true,
    view: window,
    detail: 1,
    button: 0,
    clientX:
      rect.x + rect.width / 2,
    clientY:
      rect.y + rect.height / 2
  };

  el.dispatchEvent(
    new MouseEvent(
      "pointerdown",
      point
    )
  );

  el.dispatchEvent(
    new MouseEvent(
      "mousedown",
      point
    )
  );

  el.dispatchEvent(
    new MouseEvent(
      "pointerup",
      point
    )
  );

  el.dispatchEvent(
    new MouseEvent(
      "mouseup",
      point
    )
  );

  el.dispatchEvent(
    new MouseEvent(
      "click",
      point
    )
  );
}

/**
 * A native <select> some component
 * libraries leave in the DOM purely as
 * a screen-reader / form-serialization
 * shim (aria-hidden, a single dynamic
 * <option>), while the real interactive
 * control is a sibling trigger button.
 * Treat these as decorative so they
 * don't get extracted/filled as a
 * normal <select>.
 */
function isDecorativeSelect(
  el: HTMLSelectElement
): boolean {

  return (
    el.getAttribute("aria-hidden") ===
      "true" &&
    el.options.length <= 1
  );
}

/**
 * Find the interactive trigger button
 * for a decorative <select> shim.
 */
function findComboboxTriggerForSelect(
  select: HTMLSelectElement
): HTMLElement | null {

  let container =
    select.parentElement;

  for (
    let i = 0;
    i < 5 && container;
    i++
  ) {

    const trigger =
      container.querySelector<HTMLElement>(
        "button[aria-haspopup], [role='combobox']"
      );

    if (trigger) {
      return trigger;
    }

    container =
      container.parentElement;
  }

  return null;
}

/**
 * Find the option list belonging to a
 * custom dropdown, preferring the
 * element it explicitly points at via
 * aria-controls / aria-owns.
 */
function getScopedOptionElements(
  el: HTMLElement
): HTMLElement[] {

  const controlsId =
    el.getAttribute("aria-controls") ||
    el.getAttribute("aria-owns");

  if (controlsId) {

    const scoped =
      getElementByIdDeep(
        controlsId,
        ownerRoot(el)
      );

    if (scoped) {

      const options =
        Array.from(
          scoped.querySelectorAll<HTMLElement>(
            "[role='option'], [role='menuitem'], [data-value], li"
          )
        ).filter(isRendered);

      if (options.length) {
        return options;
      }
    }
  }

  // Unscoped fallback: several custom
  // dropdowns can be mounted in the DOM
  // at once (one per select-like field
  // on the page), each leaving its own
  // closed-but-still-present menu
  // behind. Without a visibility filter
  // here, a field processed right after
  // another open/close cycle would pick
  // up the PREVIOUS dropdown's stale
  // option list instead of its own.
  // Deep-queried since a popup can be
  // portaled anywhere, including into a
  // different shadow root than the
  // trigger's own.
  const unscoped =
    queryAllDeep(
      [
        "[role='option']",
        "[role='menuitem']",
        "[data-value]",
        "[role='listbox'] li",
        "[role='menu'] li"
      ].join(",")
    ).filter(isRendered);

  if (unscoped.length) {
    return unscoped;
  }

  // Some component libraries — confirmed
  // live on Workday's own "prompt"
  // typeahead, the widget behind nearly
  // every dropdown-like field on its
  // forms (Field of Study, "How did you
  // hear about us", etc.) — mark the
  // popup container itself
  // role="listbox"/"menu" but leave every
  // individual option as a plain <div>
  // with no role, no data-value, nothing
  // any selector above can match. Without
  // this, such a field can never be
  // filled no matter what's typed into
  // it — every retry looks plausible to
  // the LLM and still fails validation,
  // which is exactly what an endless
  // fill-retry loop on a "dropdown" looks
  // like from the outside. Falling back
  // to every rendered LEAF (no child
  // elements) with real text inside such
  // a container catches this without
  // needing to special-case Workday by
  // name: whatever a person could
  // actually read and click as an option
  // is, structurally, exactly that.
  return queryAllDeep(
    "[role='listbox'], [role='menu']"
  )
    .filter(isRendered)
    .flatMap(container =>
      Array.from(
        container.querySelectorAll<HTMLElement>(
          "*"
        )
      ).filter(
        node =>
          node.children.length === 0 &&
          textOf(node).length > 0
      )
    )
    .filter(isRendered);
}

/**
 * Cheap visibility check — true if the
 * element is actually laid out on the
 * page (not display:none and not
 * detached), used to exclude closed
 * dropdown menus that libraries leave
 * mounted-but-hidden in the DOM.
 */
function isRendered(
  el: HTMLElement
): boolean {

  // getClientRects (unlike
  // offsetParent) stays accurate for
  // position: fixed elements, which is
  // how many portal-based dropdown
  // menus are positioned.
  return (
    el.getClientRects().length > 0
  );
}

/**
 * Every way a modal can be marked up.
 * Confirmed live (2026-10-22): LinkedIn's
 * redesigned Easy Apply modal is a native
 * <dialog open> with NO role="dialog" and
 * only obfuscated class names, so a
 * role-only selector found no dialog at
 * all — getStepRoot() fell back to the
 * whole page and findApplyButton() no
 * longer knew a modal was already open.
 */
const DIALOG_SELECTOR =
  "[role='dialog'], [role='alertdialog'], dialog[open], [aria-modal='true']";

/**
 * The open application modal dialog, if
 * any (e.g. LinkedIn's Easy Apply, which
 * renders as role="dialog" or a native
 * <dialog>). When a modal is open,
 * page-wide button-text matching becomes
 * ambiguous: the page BEHIND the modal
 * can still contain its own visible
 * "Next"-labelled control that has
 * nothing to do with the application —
 * confirmed live on LinkedIn, whose job
 * search results list has its own
 * pagination "Next" button with no
 * nav/landmark wrapper to exclude it by.
 * Because queryAllDeep returns light-DOM
 * matches before shadow-nested ones, that
 * pagination button was always found
 * ahead of the modal's real (shadow-DOM)
 * Next button, so clicking "Next"
 * silently paginated the job list instead
 * of advancing the application, abandoning
 * it entirely. Scoping the search to the
 * modal's own subtree once one is open
 * resolves the ambiguity at the source.
 * When several dialogs are open at once,
 * ranks them: an explicit application-modal
 * class wins, known messaging chrome is
 * excluded, and the dialog carrying the
 * most form fields beats DOM order.
 */
const CONSENT_PATTERN =
  /cookie|consent|onetrust|gdpr|truste|cc-window|privacy[-_ ]?(pref|center|settings)/i;

function isConsentDialog(dialog: Element): boolean {
  const own = `${dialog.id} ${typeof dialog.className === "string" ? dialog.className : ""} ${dialog.getAttribute("aria-label") || ""}`;
  return CONSENT_PATTERN.test(own) || !!dialog.closest("#onetrust-consent-sdk, #CybotCookiebotDialog, [id*='cookie' i]");
}

/**
 * A string for a quoted CSS attribute value ([id="..."]): only quotes
 * and backslashes need escaping. CSS.escape is for identifiers (#id)
 * and turns a leading digit into "\39 " — valid CSS, but Ashby's
 * digit-first ids made that selector fail outside Chrome (the golden
 * form tests), and a quoted value is simpler everywhere.
 */
/**
 * react-select (Greenhouse's new boards) puts an invisible
 * <input required tabindex="-1" aria-hidden="true"> beside each
 * required dropdown, only for the browser's own validation. It is not
 * a question: counted as one, every dropdown was asked twice ("Country"
 * and "Select..."), found by the golden form set. File inputs are often
 * tabindex=-1 too (Lever's resume), so they and choice inputs stay.
 */
function isValidationMirror(el: HTMLElement): boolean {
  if (!(el instanceof HTMLInputElement)) {
    return false;
  }

  // Workable wraps each native radio/checkbox in a clickable
  // <div role="radio"> (the one people use): read the question once,
  // from the wrapper, not again from the native input inside it.
  if (el.type === "radio" || el.type === "checkbox") {
    const wrapper = el.parentElement?.closest("[role='radio'], [role='checkbox']");
    return !!wrapper && wrapper !== el;
  }

  return (
    el.type !== "file" &&
    el.getAttribute("aria-hidden") === "true" &&
    el.getAttribute("tabindex") === "-1"
  );
}

function cssString(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}

/**
 * A dialog that is laid out but not shown: Oracle Candidate Experience keeps its closed side menu, a
 * `div.app-menu[role=dialog]` with `visibility: hidden`, full size on every page (seen 2026-11-05). Taken for an
 * open dialog, it hid the page's "Apply Now" button from the engine.
 */
function isHiddenShell(dialog: Element): boolean {
  return getComputedStyle(dialog).visibility === "hidden" || !((dialog as HTMLElement).innerText || "").trim();
}

function findActiveDialog(): HTMLElement | null {

  // An element matching several parts of
  // DIALOG_SELECTOR (e.g. role="dialog"
  // plus aria-modal) is returned once by
  // querySelectorAll, but a role="dialog"
  // nested inside a <dialog> would count
  // twice — keep only the outermost.
  // A cookie/consent banner is never the application: on a company's
  // own careers site (OneTrust on okta.com, seen in the golden form
  // set) it is open on first visit and, as the only dialog, became
  // the whole form ("Cookie list search", "checkbox label").
  const matched =
    queryAllDeep(
      DIALOG_SELECTOR
    ).filter(dialog => isRendered(dialog) && !isHiddenShell(dialog) && !isConsentDialog(dialog));

  const dialogs = matched.filter(
    dialog =>
      !matched.some(
        other =>
          other !== dialog &&
          other.contains(dialog)
      )
  );

  if (dialogs.length <= 1) {
    return dialogs[0] || null;
  }

  // More than one dialog can legitimately
  // be open at once — a chat/messaging
  // popup, a "complete your profile"
  // nudge, a cookie-consent banner —
  // and which ones exist varies by
  // account (notification state, feature
  // flags, first-time nudges). Picking
  // merely the LAST one is a coincidence
  // that happened to hold on the account
  // this was first tested against; prefer
  // one that actually looks like the
  // application so an unrelated dialog
  // opened alongside it can't steal the
  // scope and make every button lookup
  // come up empty.
  //
  // Confirmed live (2026-09-01): an OR of
  // "has a form field" / "has the Easy
  // Apply class" wasn't enough — LinkedIn's
  // own Messaging chat bubble is also a
  // [role='dialog'], also has a <textarea>,
  // and sorts AFTER the Easy Apply modal in
  // the DOM, so `pool[pool.length - 1]`
  // handed every button/error lookup the
  // chat widget instead of the application.
  // The agent filled the form (extraction
  // isn't dialog-scoped) then reported "no
  // Next button" and stopped every time a
  // messaging bubble happened to be open.
  // Rank instead of OR-filter: an explicit
  // application-modal class beats a dialog
  // that merely contains an input, known
  // messaging chrome is excluded outright,
  // and the dialog with the most form
  // fields wins before DOM order is even
  // consulted.
  const isMessagingChrome = (dialog: Element) =>
    /msg-overlay|msg-convo|msg-form|messaging/i.test(
      dialog.className
    ) ||
    /messaging/i.test(
      dialog.getAttribute("aria-label") || ""
    );

  // The redesigned LinkedIn modal's classes
  // are obfuscated hashes, so also accept
  // its heading ("Apply to <Company>"),
  // reached via aria-labelledby.
  const dialogHeading = (dialog: Element) => {
    const headingId =
      dialog.getAttribute("aria-labelledby");
    const heading = headingId
      ? dialog.querySelector(
          `[id="${cssString(headingId)}"]`
        ) ||
        document.getElementById(headingId)
      : null;
    return (
      heading?.textContent ||
      dialog.getAttribute("aria-label") ||
      ""
    ).trim();
  };

  const looksLikeApplication = (dialog: Element) =>
    /easy-apply|jobs-apply|application|apply-modal/i.test(
      dialog.className
    ) ||
    /^apply to\b|application/i.test(
      dialogHeading(dialog)
    );

  const fieldCount = (dialog: Element) =>
    dialog.querySelectorAll(
      "input, select, textarea"
    ).length;

  let pool = dialogs.filter(
    dialog =>
      looksLikeApplication(dialog) &&
      !isMessagingChrome(dialog)
  );

  if (pool.length === 0) {
    pool = dialogs.filter(
      dialog =>
        !isMessagingChrome(dialog) &&
        fieldCount(dialog) > 0
    );
  }

  if (pool.length === 0) {
    pool = dialogs.filter(
      dialog => !isMessagingChrome(dialog)
    );
  }

  if (pool.length === 0) {
    pool = dialogs;
  }

  return (
    [...pool].sort(
      (a, b) => fieldCount(b) - fieldCount(a)
    )[0] || null
  );
}

/**
 * False only for an element sitting BEHIND
 * a truly modal dialog (a native
 * <dialog> opened with showModal(), or
 * aria-modal="true") — the page makes it
 * inert, so nobody can fill it. Confirmed
 * live (2026-10-22) on LinkedIn's
 * redesigned Easy Apply: without this the
 * page footer's "Select language"
 * dropdown and an unlabeled background
 * checkbox were extracted as application
 * fields alongside the modal's real ones.
 * Non-modal role="dialog" popups keep the
 * old whole-page behavior.
 */
function isInsideBlockingModal(
  el: Element,
  dialog: HTMLElement | null
): boolean {

  if (!dialog) {
    return true;
  }

  const blocking =
    dialog.getAttribute("aria-modal") === "true" ||
    (dialog instanceof HTMLDialogElement &&
      dialog.matches(":modal"));

  if (!blocking) {
    return true;
  }

  // Shadow-DOM fields: compare via the
  // host chain, since contains() doesn't
  // cross shadow boundaries.
  let node: Node | null = el;
  while (node) {
    if (node === dialog || dialog.contains(node)) {
      return true;
    }
    const root = node.getRootNode();
    node =
      root instanceof ShadowRoot
        ? root.host
        : null;
  }

  return false;
}

/**
 * Root to search within for buttons/
 * errors that belong to the current
 * application step — the open modal
 * dialog if one exists, otherwise the
 * whole page (non-modal multi-step forms,
 * e.g. Workday/BambooHR wizards, have no
 * dialog to scope to).
 */
/**
 * A bot trap: a field people never see and bots fill (Oracle Candidate Experience has `input#honey-pot-1`, seen
 * 2026-11-05). Filling one marks the application as automated, so it is never read as a field.
 */
function isHoneypot(el: Element): boolean {
  const key = `${el.id} ${el.getAttribute("name") || ""} ${el.getAttribute("class") || ""}`;
  // A captcha's hidden answer box (reCAPTCHA `g-recaptcha-response`, hCaptcha, Turnstile): not a question for you.
  // Read as a field, it showed up as "required questions with no answer: Captcha" (Greenhouse, 2026-11-05).
  if (/(g-recaptcha|h-captcha|cf-turnstile)-response/i.test(`${el.id} ${el.getAttribute("name") || ""}`)) return true;
  return /honey|hpot|beecatcher|\bhp[-_]/i.test(key) || el.getAttribute("tabindex") === "-1" && el.getAttribute("autocomplete") === "off" && /trap|bot/i.test(key);
}

/**
 * A terms / privacy popup inside an application (Oracle's "Terms and Conditions" with Close and Agree): its
 * Agree / Accept button moves the application on. Only inside such a popup, never on the page itself.
 */
function findTermsAgreeButton(): HTMLElement | null {
  const dialog = findActiveDialog();
  if (!dialog || !/terms|privacy|consent|agreement|declaration/i.test(dialog.innerText.slice(0, 2000))) return null;
  return [...dialog.querySelectorAll<HTMLElement>("button, [role='button'], input[type='button'], input[type='submit']")]
    .find(b => isRendered(b) && /^(i )?(agree|accept)( and continue)?$/i.test((b.innerText || (b as HTMLInputElement).value || "").trim())) || null;
}

function getStepRoot(): ParentNode {
  return findActiveDialog() || document;
}

// ---------------------------------------------------------------
// Repeatable "+ Add"-driven sections — confirmed live on a Workday
// application: its "Work Experience" step renders NOTHING but a
// section heading and an "Add" button until that button is clicked,
// so unless something actually clicks it, none of the candidate's
// work history ever reaches the form no matter how good the
// per-field filling logic is. Detection is generic (button text +
// nearest preceding section heading + diffing which fields appear
// after a click) rather than keyed to Workday's specific markup, so
// the same code also covers any other ATS that uses the same
// "heading, then a bare Add control" pattern.
// ---------------------------------------------------------------

/**
 * A button/link that reads like "Add", "+ Add", "Add Another",
 * "Add More" — deliberately not restricted to any particular
 * trailing noun ("Add Experience" vs bare "Add"), since which
 * section it belongs to is decided separately by
 * nearestPrecedingHeading(), not by the button's own wording.
 */
function isAddButtonLike(
  el: HTMLElement
): boolean {

  const tag =
    el.tagName.toLowerCase();

  const role =
    el.getAttribute("role");

  if (
    tag !== "button" &&
    tag !== "a" &&
    role !== "button"
  ) {
    return false;
  }

  const text =
    normalizeText(textOf(el));

  return (
    /^\+?\s*add\b/.test(text) &&
    text.length < 40
  );
}

/**
 * The last heading (h1-h6, legend, role="heading") that appears
 * BEFORE `el` in document order within `root`. Unlike
 * getGroupLabel() — which looks for the first heading in an
 * ancestor's subtree, and so can't tell two sibling sections with
 * their own headings apart — this walks by reading order, which is
 * what actually distinguishes a Work Experience section's Add
 * button from Education's right below it (confirmed live: both
 * share the identical `data-automation-id="add-button"` markup on
 * Workday, with no ancestor linking either one to its own heading).
 */
function nearestPrecedingHeading(
  el: HTMLElement,
  root: ParentNode
): string {

  const headings =
    queryAllDeep(
      "h1, h2, h3, h4, h5, h6, legend, [role='heading']",
      root
    ).filter(isRendered);

  let best = "";

  for (const heading of headings) {

    const positions =
      heading.compareDocumentPosition(el);

    if (
      positions &
      Node.DOCUMENT_POSITION_FOLLOWING
    ) {
      best = textOf(heading);
    } else {
      break;
    }
  }

  return best;
}

function findAddButtonsForSection(
  root: ParentNode,
  sectionPattern: RegExp
): HTMLElement[] {

  return queryAllDeep(
    "button, a, [role='button']",
    root
  )
    .filter(isRendered)
    .filter(isAddButtonLike)
    .filter(btn =>
      sectionPattern.test(
        nearestPrecedingHeading(
          btn,
          root
        )
      )
    );
}

function collectFormFieldElements(
  root: ParentNode
): HTMLElement[] {

  return queryAllDeep(
    FORM_FIELD_SELECTOR,
    root
  ).filter(isRendered);
}

const MAX_REPEATABLE_ENTRIES = 6;

/**
 * Clicks a section's "Add" control enough times to hold
 * `desiredCount` entries (capped), tagging every field that appears
 * as a result of each click with data-jobai-entry-type/
 * data-jobai-entry-index so extractForm() can later report which
 * profile.experience entry (0 = most recent) each field belongs to.
 *
 * A block boundary is any field whose own label is essentially just
 * "Job Title"/"Position Title"/"Title"/"Role" — the one field every
 * variant of this section reliably starts with — so a section the
 * site already rendered one (or more) entries into (a default first
 * block, LinkedIn importing straight from the real profile) gets its
 * EXISTING fields tagged the same way instead of being left alone:
 * without that, a checkbox like "I currently work here" on an
 * untagged block has no entry context at all, and the per-field LLM
 * answering it falls back to has no way to know it should say "No"
 * for a role the candidate isn't in any more — confirmed as the
 * actual shape of a live report ("I'm not currently working
 * anywhere, why did it check that box").
 */
const ENTRY_BLOCK_START_PATTERN =
  /^(job\s*title|position\s*title|title|role)$/i;

function partitionEntryBlocks(
  root: ParentNode,
  sectionPattern: RegExp
): HTMLElement[][] {

  const fields =
    collectFormFieldElements(root).filter(
      field =>
        sectionPattern.test(
          nearestPrecedingHeading(
            field,
            root
          )
        )
    );

  const blocks: HTMLElement[][] = [];

  for (const field of fields) {

    const plainLabel =
      getLabel(field)
        .replace(/[*:]+\s*$/, "")
        .trim();

    const isBlockStart =
      ENTRY_BLOCK_START_PATTERN.test(
        plainLabel
      );

    if (
      isBlockStart ||
      blocks.length === 0
    ) {
      blocks.push([field]);
    } else {
      blocks[
        blocks.length - 1
      ]!.push(field);
    }
  }

  return blocks;
}

async function prepareRepeatableSection(
  entryType: string,
  sectionPattern: RegExp,
  desiredCount: number
): Promise<number> {

  if (desiredCount <= 0) {
    return 0;
  }

  const root =
    getStepRoot();

  const existingBlocks =
    partitionEntryBlocks(
      root,
      sectionPattern
    );

  existingBlocks.forEach(
    (block, index) => {
      block.forEach(field => {

        field.setAttribute(
          "data-jobai-entry-type",
          entryType
        );

        field.setAttribute(
          "data-jobai-entry-index",
          String(index)
        );
      });
    }
  );

  const target =
    Math.min(
      desiredCount,
      MAX_REPEATABLE_ENTRIES
    );

  let added =
    existingBlocks.length;

  for (
    let i = existingBlocks.length;
    i < target;
    i++
  ) {

    const buttons =
      findAddButtonsForSection(
        root,
        sectionPattern
      );

    if (buttons.length === 0) {
      break;
    }

    const button =
      buttons[buttons.length - 1];

    const before =
      new Set(
        collectFormFieldElements(root)
      );

    simulateClick(button!);

    let newFields: HTMLElement[] = [];

    for (
      let attempt = 0;
      attempt < 20 &&
        newFields.length === 0;
      attempt++
    ) {

      await new Promise(
        resolve =>
          setTimeout(resolve, 200)
      );

      newFields =
        collectFormFieldElements(
          root
        ).filter(
          el => !before.has(el)
        );
    }

    if (newFields.length === 0) {
      break;
    }

    newFields.forEach(field => {

      field.setAttribute(
        "data-jobai-entry-type",
        entryType
      );

      field.setAttribute(
        "data-jobai-entry-index",
        String(i)
      );
    });

    added++;
  }

  return added;
}

const EXPERIENCE_SECTION_PATTERN =
  /\bwork\s*experience\b|\bemployment\s*history\b|\bjob\s*history\b|\bprofessional\s*experience\b|^\s*experience\s*$/i;

const EDUCATION_SECTION_PATTERN =
  /\beducation\b|\bacademic\s*(history|background)\b|\bdegrees?\b|\bqualifications?\b/i;

/**
 * Any OTHER repeatable "+ Add" section the site has — Certifications,
 * Languages, Publications, Awards, Volunteer Experience, and
 * whatever else a given ATS invents — that isn't Work Experience or
 * Education specifically. Rather than hand-building a deterministic
 * field-mapping + profile data model for every possible section type
 * (as exists for experience), this just makes sure such a section
 * isn't left completely empty: click its Add control once (enough
 * to satisfy an "at least one entry required" validation) and tag
 * the resulting fields with an entry_type derived from the section's
 * own heading, so the LLM answering them at least gets told which
 * section/entry it's filling via the same label-enrichment path
 * used for experience fields it can't map deterministically either.
 *
 * Only ever adds ONE entry per section (never desiredCount-many,
 * since there's no per-type profile array to size it against) and
 * only for a section that's currently empty — same non-duplication
 * safety rule as prepareRepeatableSection.
 */
async function prepareGenericRepeatableSections(
  root: ParentNode,
  knownPatterns: RegExp[]
): Promise<number> {

  const addButtons =
    queryAllDeep(
      "button, a, [role='button']",
      root
    )
      .filter(isRendered)
      .filter(isAddButtonLike);

  const seenHeadings =
    new Set<string>();

  let prepared = 0;

  for (const button of addButtons) {

    const heading =
      nearestPrecedingHeading(
        button,
        root
      );

    const headingKey =
      normalizeText(heading);

    if (
      !headingKey ||
      seenHeadings.has(headingKey)
    ) {
      continue;
    }

    seenHeadings.add(headingKey);

    if (
      knownPatterns.some(pattern =>
        pattern.test(heading)
      )
    ) {
      continue;
    }

    const sectionHasExistingFields =
      collectFormFieldElements(
        root
      ).some(
        field =>
          normalizeText(
            nearestPrecedingHeading(
              field,
              root
            )
          ) === headingKey
      );

    if (sectionHasExistingFields) {
      continue;
    }

    const before =
      new Set(
        collectFormFieldElements(root)
      );

    simulateClick(button);

    let newFields: HTMLElement[] = [];

    for (
      let attempt = 0;
      attempt < 20 &&
        newFields.length === 0;
      attempt++
    ) {

      await new Promise(
        resolve =>
          setTimeout(resolve, 200)
      );

      newFields =
        collectFormFieldElements(
          root
        ).filter(
          el => !before.has(el)
        );
    }

    if (newFields.length === 0) {
      continue;
    }

    const entryType =
      headingKey
        .replace(/\s+/g, "_")
        .slice(0, 40) ||
      "entry";

    newFields.forEach(field => {

      field.setAttribute(
        "data-jobai-entry-type",
        entryType
      );

      field.setAttribute(
        "data-jobai-entry-index",
        "0"
      );
    });

    prepared++;
  }

  return prepared;
}

/**
 * Detect a checkbox group that shares a
 * "name" attribute. A single unmatched
 * checkbox is treated as a standalone
 * boolean toggle (e.g. "I agree to the
 * Terms", "Subscribe to updates").
 */
function getCheckboxGroupElements(
  el: HTMLInputElement
): HTMLInputElement[] {

  const name =
    el.getAttribute("name");

  if (name) {
    return Array.from(
      ownerRoot(el).querySelectorAll<HTMLInputElement>(
        `input[type="checkbox"][name="${cssString(name)}"]`
      )
    );
  }

  return [el];
}

/**
 * Detect text inputs that behave like a
 * date field (custom datepicker widgets
 * rarely use <input type="date">).
 */
/**
 * Whether a field is required. DOM
 * required/aria-required attributes
 * alone under-detect this — confirmed
 * on Workday, whose custom-styled
 * fields (Country, Yes/No radios) mark
 * "required" only by appending a
 * visible "*" to the label, with no
 * required/aria-required attribute at
 * all. A trailing "*" in the extracted
 * label is treated as required too.
 */
function isRequiredField(
  el: HTMLElement,
  label: string
): boolean {

  return (
    el.hasAttribute("required") ||
    el.getAttribute(
      "aria-required"
    ) === "true" ||
    // "*", or Lever's "✱" (U+2731: "Resume/CV ✱", seen in QA 2026-11-05).
    /[*✱]\s*$/.test(label.trim())
  );
}

function isDateLikeField(
  el: HTMLElement
): boolean {

  if (
    !(el instanceof HTMLInputElement)
  ) {
    return false;
  }

  if (
    [
      "date",
      "datetime-local",
      "month",
      "week"
    ].includes(el.type)
  ) {
    return false;
  }

  if (
    !["text", "search", "tel", ""].includes(
      el.type
    )
  ) {
    return false;
  }

  const hay =
    [
      el.getAttribute("placeholder"),
      el.getAttribute("name"),
      el.id,
      el.getAttribute("aria-label"),
      el.className,
      getLabel(el)
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

  // A box for only the month or only the year of a date ("Start date year", "End date month" on Greenhouse) is not a
  // date field: it takes "2024" or "June" as they are (seen live 2026-11-06: read as a date, "2024" was dropped).
  const own = `${getLabel(el)} ${el.id} ${el.getAttribute("name") || ""}`.toLowerCase();
  if (/\byear\b|-year\b|_year\b/.test(own) !== /\bmonth\b|-month\b|_month\b/.test(own) && !/\bday\b/.test(own)) {
    return false;
  }

  return /\bdate\b|\bdob\b|birth|mm\/dd\/yyyy|dd\/mm\/yyyy|yyyy-mm-dd|dd-mm-yyyy|mm-dd-yyyy|how soon can you join|when can you join|when are you available|earliest\s+(start|join|availability)|joining\s+date|start\s+date|available\s+from/.test(
    hay
  );
}

/**
 * Guess the display format expected by
 * a custom date text field.
 */
function guessDateFormat(
  el: HTMLElement
): string {

  const hints =
    [
      el.getAttribute("placeholder"),
      el.getAttribute("aria-label"),
      el.getAttribute("data-format"),
      el.getAttribute("pattern")
    ]
      .filter(Boolean)
      .join(" ")
      .toUpperCase();

  if (/DD\/MM\/YYYY/.test(hints)) {
    return "DD/MM/YYYY";
  }

  if (/MM\/DD\/YYYY/.test(hints)) {
    return "MM/DD/YYYY";
  }

  if (/YYYY\/MM\/DD/.test(hints)) {
    return "YYYY/MM/DD";
  }

  if (/YYYY-MM-DD/.test(hints)) {
    return "YYYY-MM-DD";
  }

  if (/DD-MM-YYYY/.test(hints)) {
    return "DD-MM-YYYY";
  }

  if (/MM-DD-YYYY/.test(hints)) {
    return "MM-DD-YYYY";
  }

  if (
    /DD\s+MON\s+YYYY|DD\s+MMM\s+YYYY/.test(
      hints
    )
  ) {
    return "DD MON YYYY";
  }

  if (
    /MON\s+DD,?\s+YYYY|MMM\s+DD,?\s+YYYY/.test(
      hints
    )
  ) {
    return "MON DD YYYY";
  }

  return "MM/DD/YYYY";
}

const MONTH_ABBREVIATIONS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec"
];

/**
 * Reformat an ISO (YYYY-MM-DD) date
 * string into the format a custom date
 * text field expects.
 */
function formatDateForDisplay(
  iso: string,
  format: string
): string {

  const match =
    iso
      .trim()
      .match(
        /^(\d{4})-(\d{2})-(\d{2})$/
      );

  if (!match) {
    return iso;
  }

  const [, year, month, day] = match;

  const monthAbbr =
    MONTH_ABBREVIATIONS[
      Number(month) - 1
    ] || month;

  switch (format) {
    case "DD/MM/YYYY":
      return `${day}/${month}/${year}`;
    case "MM/DD/YYYY":
      return `${month}/${day}/${year}`;
    case "YYYY/MM/DD":
      return `${year}/${month}/${day}`;
    case "DD-MM-YYYY":
      return `${day}-${month}-${year}`;
    case "MM-DD-YYYY":
      return `${month}-${day}-${year}`;
    case "DD MON YYYY":
      return `${day} ${monthAbbr} ${year}`;
    case "MON DD YYYY":
      return `${monthAbbr} ${day}, ${year}`;
    case "YYYY-MM-DD":
    default:
      return `${year}-${month}-${day}`;
  }
}

/**
 * Simulate real keystrokes for masked /
 * input-mask-driven fields that ignore
 * a one-shot value assignment.
 */
async function typeCharacters(
  el: HTMLInputElement | HTMLTextAreaElement,
  text: string,
  // false keeps focus in the box: a search-as-you-type box closes its
  // suggestion list on blur (Lever's location search).
  leave = true
): Promise<void> {

  el.focus();

  setNativeValue(el, "");

  el.dispatchEvent(
    new Event(
      "input",
      { bubbles: true }
    )
  );

  for (const char of text) {

    // keyCode/which and a keypress, as a real keyboard sends them:
    // Lever's location search (jQuery) ignored keys without them, so
    // no suggestions ever appeared (confirmed live, 2026-11-01).
    const keyCode = char.toUpperCase().charCodeAt(0);
    const charCode = char.charCodeAt(0);

    el.dispatchEvent(
      new KeyboardEvent(
        "keydown",
        { key: char, keyCode, which: keyCode, bubbles: true }
      )
    );

    el.dispatchEvent(
      new KeyboardEvent(
        "keypress",
        { key: char, keyCode: charCode, which: charCode, charCode, bubbles: true }
      )
    );

    setNativeValue(
      el,
      el.value + char
    );

    el.dispatchEvent(
      new InputEvent(
        "input",
        {
          bubbles: true,
          inputType: "insertText",
          data: char
        }
      )
    );

    el.dispatchEvent(
      new KeyboardEvent(
        "keyup",
        { key: char, keyCode, which: keyCode, bubbles: true }
      )
    );
  }

  if (!leave) {
    return;
  }

  el.dispatchEvent(
    new Event(
      "change",
      { bubbles: true }
    )
  );

  el.dispatchEvent(
    new Event(
      "blur",
      { bubbles: true }
    )
  );
}

/**
 * The currently-selected option's text
 * inside a Google Forms role="listbox"
 * dropdown — every option is pre-mounted
 * in the DOM (not revealed only on
 * open), so unlike other custom
 * dropdowns there's no need to open the
 * widget just to read the current
 * selection. Returns "" for the
 * "Choose"-style placeholder option
 * (its own data-value/text is empty),
 * matching how an unanswered field is
 * represented elsewhere.
 */
function getListboxSelectedText(
  el: HTMLElement
): string {

  const selected =
    Array.from(
      el.querySelectorAll<HTMLElement>(
        "[role='option']"
      )
    ).find(
      option =>
        option.getAttribute(
          "aria-selected"
        ) === "true"
    );

  if (!selected) {
    return "";
  }

  return (
    selected.getAttribute(
      "data-value"
    ) || textOf(selected)
  );
}

/**
 * Read a custom dropdown's option
 * list, opening it first if the
 * options aren't already present in
 * the DOM (many widgets only render
 * their menu once opened), then
 * closing it again so extraction
 * doesn't leave dropdowns hanging
 * open across the page.
 */
async function harvestComboboxOptions(
  el: HTMLElement
): Promise<string[]> {

  // Trigger buttons frequently have no
  // aria-controls/aria-owns pointing at
  // their popup (confirmed on Workday —
  // the real listbox is portaled
  // straight under <body> with no
  // relationship back to the button),
  // so an unscoped page-wide option
  // query can't reliably tell "options
  // that belong to THIS field" apart
  // from a leftover role="option"
  // element some OTHER field's widget
  // left visible (e.g. Workday shows a
  // "selected item" chip with
  // role="option" for a multi-select
  // field that was never opened at
  // all). Snapshotting what's visible
  // *before* opening and diffing
  // against what's visible *after*
  // isolates the newly-revealed set
  // regardless of any DOM/ARIA
  // relationship to the trigger.
  const before = new Set(
    getScopedOptionElements(el)
  );

  const alreadyOpen =
    el.getAttribute(
      "aria-expanded"
    ) === "true";

  if (!alreadyOpen) {

    simulateClick(el);

    await new Promise(
      resolve =>
        setTimeout(
          resolve,
          350
        )
    );
  }

  const after =
    getScopedOptionElements(el);

  const revealed =
    after.filter(
      option => !before.has(option)
    );

  const chosen =
    revealed.length > 0
      ? revealed
      : after;

  const options =
    chosen
      .map(option => textOf(option))
      .filter(Boolean);

  if (!alreadyOpen) {

    simulateClick(el);

    // Defensive backstop: if the
    // trigger-click toggle didn't
    // close whatever opened, Escape
    // usually will.
    document.dispatchEvent(
      new KeyboardEvent(
        "keydown",
        { key: "Escape", bubbles: true }
      )
    );

    await new Promise(
      resolve =>
        setTimeout(
          resolve,
          100
        )
    );
  }

  return options;
}

/**
 * Extract the current application page.
 */
/**
 * The bounds, step, example and length a text/number/date/range input states, and whether a phone box has its own
 * country-code picker, for the input-type agent (src/shared/ai-apply/input-kinds.ts).
 */
function inputMeta(el: Element): Partial<Field> {
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return {};
  const meta: Partial<Field> = {};
  const attr = (n: string) => el.getAttribute(n) ?? undefined;
  if (el instanceof HTMLInputElement) {
    if (attr("min")) meta.min = attr("min");
    if (attr("max")) meta.max = attr("max");
    if (attr("step") && attr("step") !== "any") meta.step = attr("step");
  }
  if (attr("placeholder")) meta.placeholder = attr("placeholder")!.slice(0, 60);
  if (el.maxLength > 0 && el.maxLength < 1000) meta.max_length = String(el.maxLength);
  if (el instanceof HTMLInputElement && (el.type === "tel" || /phone|mobile/i.test(`${el.name} ${el.id} ${getLabel(el)}`)) && hasPhoneCodePicker(el)) {
    meta.has_code_picker = true;
  }
  return meta;
}

/** intl-tel-input's flag dropdown, or a "+91"/"India (+91)" dropdown or code box right next to the phone box. */
function hasPhoneCodePicker(el: HTMLInputElement): boolean {
  if (el.closest(".iti, .intl-tel-input, .react-tel-input, .PhoneInput, [class*='phone-input' i]")?.querySelector(".iti__flag-container, .iti__country-container, .flag-dropdown, .PhoneInputCountry, select, [role='combobox']")) return true;
  let box: Element | null = el.parentElement;
  for (let i = 0; box && i < 3; i += 1, box = box.parentElement) {
    const near = [...box.querySelectorAll("select, [role='combobox'], input")].filter(x => x !== el && isRendered(x as HTMLElement));
    if (near.some(x => {
      const text = x instanceof HTMLSelectElement ? [...x.options].slice(0, 40).map(o => o.text).join(" ") : `${(x as HTMLInputElement).value || ""} ${x.getAttribute("aria-label") || ""} ${x.getAttribute("placeholder") || ""} ${x.getAttribute("name") || ""} ${textOf(x as HTMLElement)}`;
      return /\+\s?\d{1,3}\b|country ?code|dial ?code|calling code/i.test(text);
    })) return true;
    if (near.length > 3) break;
  }
  return false;
}

/** A canvas a person signs on: in a block that says signature / sign here, or a known signature-pad widget. */
function isSignatureCanvas(el: Element): boolean {
  if (!(el instanceof HTMLCanvasElement)) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 80 || r.height < 30) return false;
  let box: Element | null = el;
  for (let i = 0; box && i < 4; i += 1, box = box.parentElement) {
    const own = `${box.id} ${typeof box.className === "string" ? box.className : ""} ${box.getAttribute("aria-label") || ""} ${box.getAttribute("data-testid") || ""}`;
    if (/signature|sign-?pad|sig-?canvas|e-?sign/i.test(own)) return true;
    if (i >= 1 && /\b(signature|sign here|draw your sign)/i.test(textOf(box as HTMLElement).slice(0, 300))) return true;
  }
  return false;
}

/**
 * Controls that are not native inputs: a toggle switch (role=switch), a slider or rating scale (role=slider), a spin
 * button (role=spinbutton), a signature pad (canvas). `undefined` when `el` is none of these, `null` to skip it.
 */
function extractSpecialControl(el: HTMLElement, index: number): Field | null | undefined {
  const role = el.getAttribute("role");
  if (el instanceof HTMLCanvasElement) {
    if (!isSignatureCanvas(el)) return null;
    const label = getLabel(el) || getGroupLabel(el as HTMLElement) || "Signature";
    return { id: ensureId(el, index), label, type: "signature", required: isRequiredField(el, label), options: [], current_value: el.dataset.aiSigned ? "signed" : "" };
  }
  // A native <input> with one of these roles (role=switch on a checkbox) is read as that input.
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return undefined;
  if (role === "switch") {
    const label = getLabel(el) || getGroupLabel(el as HTMLElement);
    if (!label) return null;
    // Off is not an answer yet: an unset switch is asked like a question.
    return { id: ensureId(el, index), label, type: "switch", required: isRequiredField(el, label), options: ["Yes", "No"], current_value: el.getAttribute("aria-checked") === "true" ? "Yes" : "" };
  }
  if (role === "slider") {
    // A slider whose thumb wraps a real <input type=range> (MUI) is read through that input.
    if (el.querySelector("input[type='range']")) return null;
    const label = getLabel(el) || getGroupLabel(el as HTMLElement);
    if (!label) return null;
    const a = (n: string) => el.getAttribute(n) || undefined;
    return { id: ensureId(el, index), label, type: "range", required: isRequiredField(el, label), options: [], current_value: "", min: a("aria-valuemin"), max: a("aria-valuemax") };
  }
  if (role === "spinbutton") {
    if (el.querySelector("input")) return null;
    const label = getLabel(el) || getGroupLabel(el as HTMLElement);
    if (!label) return null;
    const a = (n: string) => el.getAttribute(n) || undefined;
    return { id: ensureId(el, index), label, type: "number", required: isRequiredField(el, label), options: [], current_value: a("aria-valuenow") || "", min: a("aria-valuemin"), max: a("aria-valuemax") };
  }
  return undefined;
}

/**
 * A captcha widget's own frame (reCAPTCHA's "I'm not a robot" box, hCaptcha, Cloudflare Turnstile). Never a form:
 * Target's job-alert box carries a visible reCAPTCHA frame, whose one checkbox was read as a 1-field application form
 * after "Apply on company site", so the run stopped there instead of pressing Target's Apply (2026-11-06).
 */
function isCaptchaFrame(): boolean {
  if (window === window.top) return false;
  const h = location.hostname;
  const u = location.href;
  return (/(^|\.)(google|recaptcha)\.(com|net)$/.test(h) && /\/recaptcha\//.test(u)) ||
    /(^|\.)hcaptcha\.com$/.test(h) || /(^|\.)challenges\.cloudflare\.com$/.test(h);
}

export async function extractForm() {

  if (isCaptchaFrame()) return { url: location.href, title: document.title, page_text: "", fields: [] };

  // Naukri's apply questions: one chatbot question at a time.
  const chat = naukriChatForm();
  if (chat) return chat;

  // Deep-search the whole page (a modal
  // can live in a shadow root outside
  // <main> entirely — confirmed on
  // LinkedIn's Easy Apply, hosted by a
  // shadow root under <body> — so
  // scoping to <main> would miss it),
  // then exclude header/nav chrome
  // explicitly (a language switcher, an
  // account menu — confirmed on
  // Workday, whose "main menu" hamburger
  // button reads as role=combobox-ish)
  // rather than by restricting the
  // search root.
  const activeDialog = findActiveDialog();

  const elements =
    queryAllDeep(
      FORM_FIELD_SELECTOR
    ).filter(
      el =>
        !el.closest(
          SITE_CHROME_SELECTOR
        ) &&
        // Deep shadow-root traversal
        // can sweep up more than the
        // application form — confirmed
        // live: an unrelated browser
        // extension's own hidden
        // shadow-DOM widget
        // (LinkedIn-adjacent, not part
        // of Easy Apply at all) got
        // picked up alongside the real
        // modal. It was never visible
        // on screen, so requiring an
        // actual layout box excludes
        // it without excluding
        // anything a person could
        // genuinely fill in.
        isRendered(el) &&
        isInsideBlockingModal(el, activeDialog) &&
        !isHoneypot(el) &&
        !isValidationMirror(el) &&
        !isInSideForm(el, activeDialog)
    );

  const fields: Field[] = [];

  const processedGroups =
    new Set<string>();

  for (
    const [index, el] of
      elements.entries()
  ) {

      // Switches, sliders, spin buttons and signature pads that are not native inputs.
      const special = extractSpecialControl(el as HTMLElement, index);
      if (special !== undefined) {
        if (special) fields.push(special);
        continue;
      }

      // -----------------------------
      // RADIO / CHECKBOX GROUP
      // -----------------------------

      if (
        el instanceof HTMLInputElement &&
        (
          el.type === "radio" ||
          el.type === "checkbox"
        )
      ) {

        const name =
          el.getAttribute("name");

        const groupKey =
          `${el.type}:${name || el.id || index}`;

        if (
          processedGroups.has(
            groupKey
          )
        ) {
          continue;
        }

        processedGroups.add(
          groupKey
        );

        const groupLabel =
          getGroupLabel(el);

        const id =
          ensureId(
            el,
            index
          );

        // Standalone checkbox (no
        // shared "name" / only one
        // sibling) — treat as a
        // boolean Yes/No toggle
        // instead of an option group,
        // since it has no options of
        // its own to choose from.
        if (
          el.type === "checkbox" &&
          getCheckboxGroupElements(el)
            .length <= 1
        ) {

          fields.push({
            id,

            label:
              getInputLabel(el) ||
              groupLabel,

            type: el.type,

            required:
              isRequiredField(
                el,
                getInputLabel(el) ||
                  groupLabel
              ),

            options: [
              "Yes",
              "No"
            ],

            current_value:
              el.checked
                ? "Yes"
                : "No",

            group_name:
              name || undefined,

            group_label:
              groupLabel || undefined
          });

          continue;
        }

        const options =
          getOptionsForGroup(el);

        fields.push({
          id,

          label:
            groupLabel ||
            getInputLabel(el),

          type:
            el.type,

          required:
            isRequiredField(
              el,
              groupLabel ||
                getInputLabel(el)
            ),

          options,

          current_value:
            Array.from(
              ownerRoot(el).querySelectorAll<HTMLInputElement>(
                `input[type="${el.type}"][name="${cssString(name || "")}"]:checked`
              )
            )
              .map(
                input =>
                  getInputLabel(
                    input
                  ) ||
                  input.value
              )
              .join(", "),

          group_name:
            name || undefined,

          group_label:
            groupLabel || undefined
        });

        continue;
      }

      // -----------------------------
      // ARIA RADIO GROUP — Google
      // Forms (and similar ARIA-first
      // form builders) render
      // multiple-choice questions as
      // role="radio" divs inside a
      // role="radiogroup", never a
      // native <input type="radio">.
      // -----------------------------

      if (
        el.getAttribute("role") ===
          "radio"
      ) {

        const group =
          el.closest(
            "[role='radiogroup']"
          ) as HTMLElement | null;

        const groupKey =
          `aria-radio:${
            group
              ? ensureId(group, index)
              : index
          }`;

        if (
          processedGroups.has(
            groupKey
          )
        ) {
          continue;
        }

        processedGroups.add(
          groupKey
        );

        const groupLabel =
          group
            ? getLabel(group)
            : getLabel(el);

        const optionEls =
          group
            ? Array.from(
                group.querySelectorAll<HTMLElement>(
                  "[role='radio']"
                )
              )
            : [el];

        const optionText = (
          opt: HTMLElement
        ): string =>
          opt.getAttribute(
            "aria-label"
          ) ||
          opt.getAttribute(
            "data-value"
          ) ||
          textOf(opt);

        const options =
          optionEls
            .map(optionText)
            .filter(Boolean);

        const checkedOption =
          optionEls.find(
            opt =>
              opt.getAttribute(
                "aria-checked"
              ) === "true"
          );

        fields.push({
          id:
            ensureId(el, index),

          label: groupLabel,

          type: "radio",

          required:
            isRequiredField(
              el,
              groupLabel
            ),

          options,

          current_value:
            checkedOption
              ? optionText(
                  checkedOption
                )
              : "",

          group_name:
            group
              ? group.id ||
                undefined
              : undefined,

          group_label:
            groupLabel || undefined
        });

        continue;
      }

      // -----------------------------
      // ARIA CHECKBOX — Google Forms
      // renders both a standalone
      // consent-style checkbox and a
      // "select all that apply"
      // checkbox question as
      // role="checkbox" divs, never a
      // native <input type="checkbox">.
      // A genuinely standalone one has
      // no sibling role="checkbox"
      // inside the same group
      // container.
      // -----------------------------

      if (
        el.getAttribute("role") ===
          "checkbox"
      ) {

        const group =
          (
            el.closest(
              "[role='group']"
            ) ||
            el.closest(
              "[role='list']"
            )
          ) as HTMLElement | null;

        const siblingCheckboxes =
          group
            ? Array.from(
                group.querySelectorAll<HTMLElement>(
                  "[role='checkbox']"
                )
              )
            : [el];

        const groupKey =
          `aria-checkbox:${
            group
              ? ensureId(group, index)
              : index
          }`;

        if (
          processedGroups.has(
            groupKey
          )
        ) {
          continue;
        }

        processedGroups.add(
          groupKey
        );

        const optionText = (
          opt: HTMLElement
        ): string =>
          opt.getAttribute(
            "aria-label"
          ) ||
          opt.getAttribute(
            "data-value"
          ) ||
          textOf(opt);

        if (
          siblingCheckboxes.length <=
          1
        ) {

          const label =
            optionText(el) ||
            getLabel(el);

          fields.push({
            id:
              ensureId(el, index),

            label,

            type: "checkbox",

            required:
              isRequiredField(
                el,
                label
              ),

            options: [
              "Yes",
              "No"
            ],

            current_value:
              el.getAttribute(
                "aria-checked"
              ) === "true"
                ? "Yes"
                : "No"
          });

          continue;
        }

        const groupLabel =
          group
            ? getLabel(group)
            : "";

        const options =
          siblingCheckboxes
            .map(optionText)
            .filter(Boolean);

        const checkedOptions =
          siblingCheckboxes.filter(
            opt =>
              opt.getAttribute(
                "aria-checked"
              ) === "true"
          );

        fields.push({
          id:
            ensureId(el, index),

          label: groupLabel,

          type: "checkbox",

          required:
            isRequiredField(
              el,
              groupLabel
            ),

          options,

          current_value:
            checkedOptions
              .map(optionText)
              .join(", "),

          group_name:
            group
              ? group.id ||
                undefined
              : undefined,

          group_label:
            groupLabel || undefined
        });

        continue;
      }

      // -----------------------------
      // SELECT
      // -----------------------------

      if (
        el instanceof HTMLSelectElement
      ) {

        // Some component libraries
        // leave a screen-reader-only
        // shim <select> in the DOM
        // (aria-hidden, a single
        // dynamic <option>) while the
        // real interactive control is
        // a sibling trigger button.
        // Skip the shim — the trigger
        // button is separately picked
        // up by the CUSTOM COMBOBOX
        // branch below since it also
        // matches the element query.
        if (
          isDecorativeSelect(el) &&
          findComboboxTriggerForSelect(
            el
          )
        ) {
          continue;
        }

        const label =
          getLabel(el);

        if (!label) {
          continue;
        }

        fields.push({
          id:
            ensureId(
              el,
              index
            ),

          label,

          type:
            el.multiple
              ? "multi-select"
              : "select",

          required:
            isRequiredField(
              el,
              label
            ),

          options:
            getSelectOptions(el),

          current_value:
            selectCurrentValue(el)
        });

        continue;
      }

      // -----------------------------
      // FILE
      // -----------------------------

      if (
        el instanceof HTMLInputElement &&
        el.type === "file"
      ) {

        const label =
          getLabel(el);

        if (!label) {
          continue;
        }

        fields.push({
          id:
            ensureId(
              el,
              index
            ),

          label,

          type: "file",

          required:
            isRequiredField(
              el,
              label
            ),

          options: [],

          current_value:
            el.files?.[0]?.name ||
            ""
        });

        continue;
      }

      // -----------------------------
      // CUSTOM COMBOBOX
      // -----------------------------

      if (
        isCustomCombobox(el)
      ) {

        const label =
          getLabel(el);

        if (!label) {
          continue;
        }

        // The option list for many
        // custom dropdowns (BambooHR's
        // Fabric select among them)
        // only exists in the DOM once
        // opened, so briefly open /
        // close it to harvest the real
        // options instead of reporting
        // an empty list.
        const options =
          await harvestComboboxOptions(
            el
          );

        fields.push({
          id:
            ensureId(
              el,
              index
            ),

          label,

          type:
            "combobox",

          required:
            isRequiredField(
              el,
              label
            ),

          options,

          // A <button>-based trigger's
          // .value can hold an opaque
          // internal id rather than
          // what's shown (confirmed on
          // Workday: a Country button
          // read value="c4f78be1a8..."
          // while its visible text was
          // "India") — prefer the
          // visible text there. A real
          // <input>-backed combobox's
          // .value IS what's shown, so
          // keep that preference for
          // those. A Google Forms
          // dropdown IS the
          // role="listbox" element
          // itself — textOf(el) would
          // concatenate every option's
          // text (all pre-mounted in the
          // DOM, not just the selected
          // one), so read the selected
          // option specifically instead.
          current_value:
            el.getAttribute("role") ===
              "listbox"
              ? getListboxSelectedText(
                  el
                )
              : el instanceof
                  HTMLButtonElement
                ? (
                    textOf(el) ||
                    el.value
                  )
                : (
                    (
                      el as HTMLInputElement
                    ).value ||
                    textOf(el)
                  )
        });

        continue;
      }

      // -----------------------------
      // NORMAL TEXT / NUMBER / DATE
      // -----------------------------

      const label =
        getLabel(el);

      if (!label) {
        continue;
      }

      let type = "text";

      if (
        el instanceof HTMLInputElement
      ) {
        type =
          el.type || "text";
      } else if (
        el instanceof HTMLTextAreaElement
      ) {
        type =
          "textarea";
      }

      if (
        isDateLikeField(el)
      ) {
        type = "date";
      }

      fields.push({
        id:
          ensureId(
            el,
            index
          ),

        label,

        type,

        required:
          isRequiredField(
            el,
            label
          ),

        options: [],

        current_value:
          (
            el as HTMLInputElement
          ).value || "",

        ...inputMeta(el)
      });
  }

  // Google Forms' file-upload question
  // has no native <input type="file">
  // at all — confirmed live: "Add file"
  // is a role="button" div that opens
  // Google's own Picker dialog in an
  // embedded iframe, not something the
  // regular element-discovery pass
  // above finds (a bare [role='button']
  // selector there would sweep up every
  // ordinary button on any ATS as a
  // "field", so this is deliberately a
  // separate, narrowly-worded pass
  // instead).
  const fileUploadTriggers =
    queryAllDeep(
      "[role='button']"
    ).filter(
      trigger =>
        isRendered(trigger) &&
        /^add file$/i.test(
          textOf(trigger).trim()
        )
    );

  fileUploadTriggers.forEach(
    (trigger, i) => {

      const label =
        getGroupLabel(trigger) ||
        getLabel(trigger);

      if (!label) {
        return;
      }

      fields.push({
        id:
          ensureId(
            trigger,
            elements.length + i
          ),

        label,

        type: "file",

        required:
          isRequiredField(
            trigger,
            label
          ),

        options: [],

        current_value: ""
      });
    }
  );

  // Attach entry_type/entry_index to any field that lives inside a
  // block prepareRepeatableSection() created, so the side panel
  // knows which profile.experience entry each one belongs to. Done
  // as a lookup pass over the finished list rather than inline at
  // each fields.push() site above (there are ~10 of them) — the
  // element is always findable back by id since ensureId()
  // guarantees field.id matches either the element's real id or its
  // data-jobai-id attribute.
  for (const field of fields) {

    const el =
      queryAllDeep(
        `[id="${cssString(field.id)}"], [data-jobai-id="${cssString(field.id)}"]`
      )[0];

    if (!el) {
      continue;
    }

    const entryType =
      el.getAttribute(
        "data-jobai-entry-type"
      );

    const entryIndexRaw =
      el.getAttribute(
        "data-jobai-entry-index"
      );

    if (entryType && entryIndexRaw !== null) {
      field.entry_type = entryType;
      field.entry_index = Number(entryIndexRaw);
      continue;
    }

    // Greenhouse's employment block (job-boards.greenhouse.io, seen 2026-11-05 on Motive): ids company-name-0,
    // title-0, start-date-month-0, start-date-year-0, end-date-month-0, end-date-year-0, current-role-0_1. Without
    // this, a remembered "Start date year" from an education form (2017) was written into the job's dates.
    const greenhouseJob = GREENHOUSE_EMPLOYMENT_ID.exec(field.id);
    if (greenhouseJob) {
      field.entry_type = "experience";
      field.entry_index = Number(greenhouseJob[1]);
    }
  }

  const pageText =
    textOf(
      document.querySelector(
        "main"
      )
    ) ||
    textOf(
      document.body
    );

  return {
    url:
      location.href,

    title:
      document.title,

    page_text:
      pageText.slice(
        0,
        1500
      ),

    // A label that is only template code (Knockout's "ko if: showError /ko" on Oracle's terms link) is no field.
    fields: fields.filter(f => !/^ko\b[\s\S]*\/ko$/i.test(f.label.trim()))
  };
}

/**
 * Find element by generated Job AI ID.
 */
/**
 * Re-locate a field by its label when
 * the id captured at extraction time no
 * longer resolves. Some component
 * libraries (MUI's useId() among them)
 * regenerate element ids on re-render,
 * so filling an earlier field can
 * silently invalidate the ids of later
 * ones captured in the same extraction
 * pass — the label text itself is far
 * more stable across those re-renders.
 */
function findElementByLabel(
  label: string
): HTMLElement | null {

  const target =
    normalizeText(label);

  if (!target) {
    return null;
  }

  const candidates =
    queryAllDeep(
      [
        "input:not([type='hidden'])",
        "textarea",
        "select",
        "[role='textbox']",
        "[role='combobox']",
        "[aria-haspopup='listbox']",
        "[aria-haspopup='menu']",
        "[aria-haspopup='true']",
        // Google Forms builds every
        // question type other than plain
        // text as one of these ARIA
        // widgets instead of a native
        // input/select — confirmed live:
        // role="radio"/"checkbox" for
        // multiple-choice/checkbox
        // questions, role="listbox" for
        // its dropdown questions (the
        // listbox element itself is the
        // clickable widget, not a
        // separate trigger).
        "[role='radio']",
        "[role='checkbox']",
        "[role='listbox']"
      ].join(",")
    ).filter(
      el =>
        !el.closest(
          SITE_CHROME_SELECTOR
        ) &&
        isRendered(el)
    );

  const labelOf = (
    el: HTMLElement
  ): string =>
    normalizeText(
      el instanceof HTMLInputElement &&
      (
        el.type === "radio" ||
        el.type === "checkbox"
      )
        ? getGroupLabel(el) ||
          getInputLabel(el)
        : getLabel(el)
    );

  const exact =
    candidates.find(
      el => labelOf(el) === target
    );

  if (exact) {
    return exact;
  }

  return (
    candidates.find(el => {

      const elLabel =
        labelOf(el);

      return (
        elLabel.length > 0 &&
        fuzzyTextMatch(elLabel, target)
      );
    }) || null
  );
}

function findElement(
  id: string,
  label?: string
): HTMLElement | null {

  const byId =
    queryAllDeep(
      `[data-jobai-id="${cssString(id)}"]`
    )[0] ||
    getElementByIdDeep(id);

  if (byId) {
    return byId;
  }

  if (label) {
    return findElementByLabel(label);
  }

  return null;
}

/**
 * Set React/Angular/Vue controlled input value.
 */
function setNativeValue(
  element:
    | HTMLInputElement
    | HTMLTextAreaElement,
  value: string
) {

  const prototype =
    Object.getPrototypeOf(
      element
    );

  const descriptor =
    Object.getOwnPropertyDescriptor(
      prototype,
      "value"
    );

  descriptor?.set?.call(
    element,
    value
  );
}

/**
 * Fill normal text/date/number fields.
 */
function fillText(
  el:
    | HTMLInputElement
    | HTMLTextAreaElement,
  value: string
): boolean {

  setNativeValue(
    el,
    value
  );

  el.dispatchEvent(
    new Event(
      "input",
      { bubbles: true }
    )
  );

  el.dispatchEvent(
    new Event(
      "change",
      { bubbles: true }
    )
  );

  el.dispatchEvent(
    new Event(
      "blur",
      { bubbles: true }
    )
  );

  return true;
}

/**
 * Match dropdown option intelligently.
 */
function findMatchingOption(
  options: HTMLOptionElement[],
  answer: string
): HTMLOptionElement | undefined {

  const target =
    normalizeText(
      answer
    );

  // Exact text/value
  let match =
    options.find(
      option =>
        normalizeText(
          option.text
        ) === target ||
        normalizeText(
          option.value
        ) === target
    );

  if (match) {
    return match;
  }

  // Whole-word contains
  match =
    options.find(option =>
      fuzzyTextMatch(
        normalizeText(option.text),
        target
      )
    );

  return match;
}

/**
 * Fill native select.
 */
function fillSelect(
  el: HTMLSelectElement,
  value: string
): boolean {

  const values =
    value
      .split(",")
      .map(x =>
        normalizeText(x)
      )
      .filter(Boolean);

  if (el.multiple) {

    let matched = 0;

    Array.from(
      el.options
    ).forEach(
      option => {

        const text =
          normalizeText(
            option.text
          );

        const optionValue =
          normalizeText(
            option.value
          );

        const selected =
          values.some(
            value =>
              value === optionValue ||
              fuzzyTextMatch(text, value)
          );

        option.selected =
          selected;

        if (selected) {
          matched++;
        }
      }
    );

    el.dispatchEvent(
      new Event(
        "input",
        { bubbles: true }
      )
    );

    el.dispatchEvent(
      new Event(
        "change",
        { bubbles: true }
      )
    );

    return matched > 0;
  }

  const option =
    findMatchingOption(
      Array.from(
        el.options
      ),
      value
    );

  if (!option) {
    return false;
  }

  el.value =
    option.value;

  el.dispatchEvent(
    new Event(
      "input",
      { bubbles: true }
    )
  );

  el.dispatchEvent(
    new Event(
      "change",
      { bubbles: true }
    )
  );

  return true;
}

/**
 * Get radio/checkbox option label.
 */
function getOptionText(
  input: HTMLInputElement
): string {

  return normalizeText(
    getInputLabel(
      input
    ) ||
    input.value
  );
}

/**
 * Fill radio group.
 */
function fillRadio(
  input: HTMLInputElement,
  answer: string
): boolean {

  const name =
    input.getAttribute(
      "name"
    );

  if (!name) {
    return false;
  }

  const target =
    normalizeText(
      answer
    );

  const radios =
    Array.from(
      ownerRoot(input).querySelectorAll<HTMLInputElement>(
        `input[type="radio"][name="${cssString(name)}"]`
      )
    );

  const match =
    radios.find(
      radio => {

        const option =
          getOptionText(
            radio
          );

        return fuzzyTextMatch(
          option,
          target
        );
      }
    );

  if (!match) {
    return false;
  }

  // React wires a checkbox/radio's
  // onChange to the native CLICK event,
  // not input/change — setting
  // .checked directly and dispatching
  // input/change updates the raw DOM
  // property but never reaches React's
  // controlled state, so the UI stays
  // visually unchecked (confirmed
  // against BambooHR's MUI-based radio
  // questions).
  if (!match.checked) {
    simulateClick(match);
  }

  return true;
}

/**
 * Fill a standalone boolean checkbox
 * (e.g. "I agree to the Terms",
 * "Subscribe to updates") based on a
 * Yes/No style answer, falling back to
 * matching the checkbox's own label
 * text against the answer.
 */
function fillStandaloneCheckbox(
  input: HTMLInputElement,
  answer: string
): boolean {

  const target =
    normalizeText(answer);

  const positive = [
    "yes",
    "true",
    "checked",
    "agree",
    "agreed",
    "accept",
    "accepted",
    "confirm",
    "confirmed",
    "1"
  ];

  const negative = [
    "no",
    "false",
    "unchecked",
    "decline",
    "declined",
    "disagree",
    "0"
  ];

  let shouldCheck: boolean;

  if (
    positive.some(
      p => containsWholeWord(target, p)
    )
  ) {
    shouldCheck = true;
  } else if (
    negative.some(
      p => containsWholeWord(target, p)
    )
  ) {
    shouldCheck = false;
  } else {

    const label =
      normalizeText(
        getInputLabel(input)
      );

    shouldCheck =
      target.length > 0 &&
      fuzzyTextMatch(label, target);
  }

  // A click toggles a checkbox, so
  // only click when the current state
  // doesn't already match — and click
  // rather than mutate .checked
  // directly, since React's onChange
  // for checkboxes/radios is wired to
  // the native click event.
  if (input.checked !== shouldCheck) {
    simulateClick(input);
  }

  return true;
}

/**
 * Fill checkbox group.
 */
function fillCheckboxes(
  input: HTMLInputElement,
  answer: string
): boolean {

  const name =
    input.getAttribute(
      "name"
    );

  if (
    !name ||
    getCheckboxGroupElements(input)
      .length <= 1
  ) {
    return fillStandaloneCheckbox(
      input,
      answer
    );
  }

  const selected =
    answer
      .split(",")
      .map(x =>
        normalizeText(x)
      )
      .filter(Boolean);

  const checkboxes =
    Array.from(
      ownerRoot(input).querySelectorAll<HTMLInputElement>(
        `input[type="checkbox"][name="${cssString(name)}"]`
      )
    );

  let matched = 0;

  checkboxes.forEach(
    checkbox => {

      const option =
        getOptionText(
          checkbox
        );

      const shouldCheck =
        selected.some(value =>
          fuzzyTextMatch(option, value)
        );

      // Click rather than mutate
      // .checked directly — React's
      // onChange for checkboxes is
      // wired to the native click
      // event, not input/change.
      if (
        checkbox.checked !==
        shouldCheck
      ) {
        simulateClick(checkbox);
      }

      if (shouldCheck) {
        matched++;
      }
    }
  );

  return matched > 0;
}

/**
 * Fill custom combobox.
 *
 * This handles many modern React-style
 * searchable dropdowns.
 */
async function fillCombobox(
  el: HTMLElement,
  value: string
): Promise<boolean> {

  const target =
    normalizeText(
      value
    );

  // If it's actually an input
  if (
    el instanceof HTMLInputElement
  ) {

    setNativeValue(
      el,
      value
    );

    el.dispatchEvent(
      new Event(
        "input",
        { bubbles: true }
      )
    );

    await new Promise(
      resolve =>
        setTimeout(
          resolve,
          300
        )
    );
  }

  // Open dropdown. A plain el.click()
  // synthesizes detail: 0, which some
  // widgets (e.g. BambooHR's Fabric
  // select) silently ignore — a real
  // click always carries detail: 1.
  simulateClick(el);

  await new Promise(
    resolve =>
      setTimeout(
        resolve,
        300
      )
  );

  const options =
    getScopedOptionElements(el);

  const match =
    options.find(
      option => {

        const text =
          normalizeText(
            textOf(
              option
            )
          );

        const dataValue =
          normalizeText(
            option.getAttribute(
              "data-value"
            ) || ""
          );

        return (
          dataValue === target ||
          fuzzyTextMatch(text, target)
        );
      }
    );

  if (!match) {
    return false;
  }

  simulateClick(match);

  return true;
}

/**
 * Fill an ARIA role="radio" question
 * (Google Forms multiple-choice, and
 * similar ARIA-first form builders) —
 * clicks the option in the same
 * role="radiogroup" whose text matches
 * the answer, same as the native radio
 * fill: a click is required rather than
 * an attribute mutation, since these
 * widgets update their own React-style
 * state from the click event, not from
 * aria-checked being set directly.
 */
function fillAriaRadio(
  el: HTMLElement,
  answer: string
): boolean {

  const group =
    el.closest(
      "[role='radiogroup']"
    ) as HTMLElement | null;

  const optionEls =
    group
      ? Array.from(
          group.querySelectorAll<HTMLElement>(
            "[role='radio']"
          )
        )
      : [el];

  const target =
    normalizeText(answer);

  const match =
    optionEls.find(opt => {

      const text =
        normalizeText(
          opt.getAttribute(
            "aria-label"
          ) ||
            opt.getAttribute(
              "data-value"
            ) ||
            textOf(opt)
        );

      return fuzzyTextMatch(
        text,
        target
      );
    });

  if (!match) {
    return false;
  }

  if (
    match.getAttribute(
      "aria-checked"
    ) !== "true"
  ) {
    simulateClick(match);
  }

  return true;
}

/**
 * Fill an ARIA role="checkbox"
 * question — a "select all that
 * apply" group (multiple role=
 * "checkbox" siblings inside the same
 * group container) or a standalone
 * consent-style toggle, mirroring the
 * native checkbox fill logic exactly
 * except for the ARIA element shape.
 */
function fillAriaCheckbox(
  el: HTMLElement,
  answer: string
): boolean {

  const group =
    (
      el.closest(
        "[role='group']"
      ) ||
      el.closest(
        "[role='list']"
      )
    ) as HTMLElement | null;

  const siblingCheckboxes =
    group
      ? Array.from(
          group.querySelectorAll<HTMLElement>(
            "[role='checkbox']"
          )
        )
      : [el];

  const optionText = (
    opt: HTMLElement
  ): string =>
    opt.getAttribute(
      "aria-label"
    ) ||
    opt.getAttribute(
      "data-value"
    ) ||
    textOf(opt);

  if (siblingCheckboxes.length <= 1) {

    const target =
      normalizeText(answer);

    const positive = [
      "yes",
      "true",
      "checked",
      "agree",
      "agreed",
      "accept",
      "accepted",
      "confirm",
      "confirmed",
      "1"
    ];

    const negative = [
      "no",
      "false",
      "unchecked",
      "decline",
      "declined",
      "disagree",
      "0"
    ];

    let shouldCheck: boolean;

    if (
      positive.some(p =>
        containsWholeWord(target, p)
      )
    ) {
      shouldCheck = true;
    } else if (
      negative.some(p =>
        containsWholeWord(target, p)
      )
    ) {
      shouldCheck = false;
    } else {

      const label =
        normalizeText(
          optionText(el)
        );

      shouldCheck =
        target.length > 0 &&
        fuzzyTextMatch(
          label,
          target
        );
    }

    if (
      (
        el.getAttribute(
          "aria-checked"
        ) === "true"
      ) !== shouldCheck
    ) {
      simulateClick(el);
    }

    return true;
  }

  const selected =
    answer
      .split(",")
      .map(part =>
        normalizeText(part)
      )
      .filter(Boolean);

  let matched = 0;

  siblingCheckboxes.forEach(
    checkbox => {

      const option =
        normalizeText(
          optionText(checkbox)
        );

      const shouldCheck =
        selected.some(value =>
          fuzzyTextMatch(
            option,
            value
          )
        );

      if (
        (
          checkbox.getAttribute(
            "aria-checked"
          ) === "true"
        ) !== shouldCheck
      ) {
        simulateClick(checkbox);
      }

      if (shouldCheck) {
        matched++;
      }
    }
  );

  return matched > 0;
}

/**
 * Fill native date input.
 *
 * Browser date inputs require YYYY-MM-DD.
 */
function fillDate(
  el: HTMLInputElement,
  value: string
): boolean {

  let dateValue =
    value.trim();

  // DD/MM/YYYY
  let match =
    dateValue.match(
      /^(\d{2})\/(\d{2})\/(\d{4})$/
    );

  if (match) {
    dateValue =
      `${match[3]}-${match[2]}-${match[1]}`;
  }

  // DD-MM-YYYY
  match =
    dateValue.match(
      /^(\d{2})-(\d{2})-(\d{4})$/
    );

  if (match) {
    dateValue =
      `${match[3]}-${match[2]}-${match[1]}`;
  }

  setNativeValue(
    el,
    dateValue
  );

  el.dispatchEvent(
    new Event(
      "input",
      { bubbles: true }
    )
  );

  el.dispatchEvent(
    new Event(
      "change",
      { bubbles: true }
    )
  );

  return true;
}

/**
 * Find the day cell inside an open
 * LinkedIn "artdeco-calendar" widget
 * matching the target date, using the
 * cell's own aria-label (spells out the
 * full weekday/month/day/year, e.g.
 * "Saturday, August 22, 2026.") — this
 * avoids any ambiguity about which
 * month's grid is currently showing.
 */
function findArtdecoCalendarDayButton(
  target: Date
): HTMLElement | null {

  const buttons =
    queryAllDeep(
      "[data-calendar-day]"
    ).filter(isRendered);

  const targetLabel =
    target.toLocaleDateString(
      "en-US",
      {
        month: "long",
        day: "numeric",
        year: "numeric"
      }
    );

  return (
    buttons.find(button =>
      (
        button.getAttribute(
          "aria-label"
        ) || ""
      ).includes(targetLabel)
    ) || null
  );
}

/**
 * Fill a LinkedIn "artdeco-calendar"
 * date-picker widget — confirmed live on
 * an Easy Apply "How soon can you join?"
 * question (a Workable-powered field,
 * but the calendar itself is LinkedIn's
 * own shared component, so this applies
 * regardless of which ATS is behind the
 * question). Typing a value into the
 * underlying text input alone does NOT
 * register as a real answer here — the
 * widget only accepts an actual click on
 * a rendered day cell in its popup grid,
 * so a typed value left the field
 * showing "Please enter a valid answer"
 * no matter what format was typed
 * (matching what looked like the agent
 * "getting stuck" — Next/Review kept
 * silently failing this still-invalid
 * required field). Returns false (so the
 * caller can fall back to the masked-
 * text approach) if no calendar popup
 * ever appears — most date fields aren't
 * this widget.
 */
async function fillArtdecoCalendar(
  el: HTMLElement,
  value: string
): Promise<boolean> {

  const match =
    value
      .trim()
      .match(
        /^(\d{4})-(\d{2})-(\d{2})$/
      );

  if (!match) {
    return false;
  }

  const [, year, month, day] = match;

  const target = new Date(
    Number(year),
    Number(month) - 1,
    Number(day)
  );

  simulateClick(el);

  await new Promise(
    resolve =>
      setTimeout(resolve, 350)
  );

  let dayButton =
    findArtdecoCalendarDayButton(
      target
    );

  if (
    !dayButton &&
    queryAllDeep(
      "[data-calendar-day]"
    ).length === 0
  ) {
    // No calendar popup opened at all —
    // this isn't an artdeco-calendar
    // field, let the caller try its own
    // approach instead.
    return false;
  }

  // The calendar opens on the current
  // month — click through to the target
  // month if needed, bounded so a
  // mismatched/unreachable date can't
  // loop forever.
  for (
    let attempt = 0;
    !dayButton && attempt < 14;
    attempt++
  ) {

    const nextMonthButton =
      queryAllDeep(
        "[aria-label='Next month']"
      )[0];

    if (!nextMonthButton) {
      break;
    }

    simulateClick(nextMonthButton);

    await new Promise(
      resolve =>
        setTimeout(resolve, 200)
    );

    dayButton =
      findArtdecoCalendarDayButton(
        target
      );
  }

  if (!dayButton) {
    return false;
  }

  simulateClick(dayButton);

  return true;
}

/**
 * Fill a custom (non-native) date text
 * field. The backend always returns
 * ISO (YYYY-MM-DD) for date fields, so
 * reformat it to whatever display
 * format the widget appears to expect,
 * then fall back to simulated
 * keystrokes if a one-shot value
 * assignment didn't stick (common with
 * masked-input date pickers).
 */
async function fillDateText(
  el: HTMLInputElement,
  value: string
): Promise<boolean> {

  // Try LinkedIn's own calendar-popup
  // widget first — clicking the field
  // opens it if it's actually this
  // pattern, and this returns false with
  // no side effects otherwise (falls
  // through to the masked-text path
  // below).
  if (
    await fillArtdecoCalendar(
      el,
      value
    )
  ) {
    return true;
  }

  const format =
    guessDateFormat(el);

  const display =
    formatDateForDisplay(
      value.trim(),
      format
    );

  setNativeValue(
    el,
    display
  );

  el.dispatchEvent(
    new Event(
      "input",
      { bubbles: true }
    )
  );

  el.dispatchEvent(
    new Event(
      "change",
      { bubbles: true }
    )
  );

  await new Promise(
    resolve =>
      setTimeout(
        resolve,
        150
      )
  );

  if (el.value !== display) {
    await typeCharacters(
      el,
      display
    );
  } else {
    el.dispatchEvent(
      new Event(
        "blur",
        { bubbles: true }
      )
    );
  }

  return true;
}

/**
 * Last-resort recovery for a field that
 * keeps failing validation despite a
 * plausible, well-formatted typed
 * answer. Some widgets only accept an
 * actual click on a rendered option/day
 * cell, never a typed value, no matter
 * how correct that value looks —
 * confirmed live on LinkedIn's own
 * artdeco-calendar date picker, but this
 * generalizes to any similar "click to
 * reveal selectable options" pattern the
 * normal type-specific fill path didn't
 * already recognize (e.g. a field
 * extracted as plain text/combobox that
 * turns out to behave like this too).
 * Rather than special-casing each such
 * widget as it's discovered, this is
 * meant as a general fallback the error-
 * recovery loop reaches for whenever a
 * field is still invalid after a normal
 * fill+re-answer — click the field to
 * reveal whatever surface it actually
 * has, then look for a candidate
 * matching `value`: a calendar day cell
 * (by date), or any newly-revealed
 * option/menu-item-like element (by
 * fuzzy text match) — and click it if
 * found. Returns false, having changed
 * nothing observable, if no matching
 * candidate turns up.
 */
async function forceInteractiveFill(
  el: HTMLElement,
  value: string
): Promise<boolean> {

  const dateMatch =
    value
      .trim()
      .match(
        /^(\d{4})-(\d{2})-(\d{2})$/
      );

  if (dateMatch) {

    const [, year, month, day] =
      dateMatch;

    const target = new Date(
      Number(year),
      Number(month) - 1,
      Number(day)
    );

    simulateClick(el);

    await new Promise(
      resolve =>
        setTimeout(resolve, 350)
    );

    const dayButton =
      findArtdecoCalendarDayButton(
        target
      );

    if (dayButton) {
      simulateClick(dayButton);
      return true;
    }
  }

  // Generic option/menu-item reveal —
  // the same "snapshot before, diff
  // after opening" approach already used
  // for custom comboboxes, so a field
  // that turns out to behave like one
  // (without having been extracted as
  // one) still gets a real chance.
  const before =
    new Set(
      getScopedOptionElements(el)
    );

  simulateClick(el);

  await new Promise(
    resolve =>
      setTimeout(resolve, 350)
  );

  const after =
    getScopedOptionElements(el);

  const revealed =
    after.filter(
      option => !before.has(option)
    );

  const candidates =
    revealed.length > 0
      ? revealed
      : after;

  const target =
    normalizeText(value);

  const match =
    candidates.find(option =>
      fuzzyTextMatch(
        normalizeText(
          textOf(option)
        ),
        target
      )
    );

  if (match) {
    simulateClick(match);
    return true;
  }

  // Nothing matched — this isn't a
  // dropdown/combobox at all (a plain
  // number/text input reveals nothing to
  // click, click(el) above just focuses
  // it). Confirmed live as a real gap: a
  // LinkedIn numeric field
  // ("Experience in Product
  // Management?") that failed validation
  // on the normal fill reached this
  // function and got NOTHING beyond two
  // pointless clicks — no code path here
  // ever actually attempted to write the
  // value for a plain text-editable
  // field, so the correct number the LLM
  // had already computed never made it
  // in. One honest retry via the normal
  // setter, targeted at exactly this
  // element, before giving up entirely.
  if (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement
  ) {
    return fillText(el, value);
  }

  // Close whatever this may have opened
  // rather than leaving it hanging.
  simulateClick(el);

  return false;
}

type MultiValueTagFillResult =
  | "filled"
  | "unfillable"
  | "not_this_widget";

/**
 * A "type a value, click the matching popup option, the input
 * clears and a separate chip is left behind, repeat" multi-add
 * widget — confirmed live on Workday's Skills field, which turns
 * out to be the exact same underlying search/prompt component as
 * its single-select fields (Field of Study, "How did you hear about
 * us"), just used to collect several answers instead of one. Filling
 * it the normal one-shot way just pastes the whole comma-joined
 * answer ("Product Management, AI, Generative AI, Data Products") in
 * as one literal string instead of adding each skill as its own
 * chip — this splits the answer and adds each part the way a person
 * actually would: search, pick the match, watch the box clear,
 * search the next one.
 *
 * Also confirmed live: this specific widget's search only responds
 * to real, OS-trusted keystrokes — an empty-string
 * dispatchEvent(new KeyboardEvent(...)) typed value never produces
 * any result, no matter how it's dispatched, because a content
 * script (this code) cannot mint a trusted input event; that's a
 * browser security boundary, not something fixable in JS. So a
 * rendered listbox/menu popup existing at all is itself proof this
 * IS this kind of widget, independent of whether typing into it
 * managed to surface a match — and once that's true, the caller must
 * never fall back to a raw one-shot paste (it would just leave the
 * widget in a broken half-typed state); it should leave the field
 * unfilled and let the normal validation/human-escalation path
 * handle it instead. "not_this_widget" is reserved for the case
 * where no popup shows up at all, e.g. an ordinary comma-containing
 * plain-text field like an address.
 */
async function fillMultiValueTagInput(
  el: HTMLInputElement,
  value: string
): Promise<MultiValueTagFillResult> {

  const tokens =
    value
      .split(",")
      .map(part => part.trim())
      .filter(Boolean);

  if (tokens.length < 2) {
    return "not_this_widget";
  }

  let addedAny = false;
  let sawPopup = false;

  for (
    let i = 0;
    i < tokens.length;
    i++
  ) {

    const token = tokens[i]!;

    await typeCharacters(
      el,
      token
    );

    let options: HTMLElement[] = [];

    for (
      let attempt = 0;
      attempt < 15 &&
        options.length === 0;
      attempt++
    ) {

      await new Promise(
        resolve =>
          setTimeout(resolve, 200)
      );

      options =
        getScopedOptionElements(el);
    }

    const popupContainerExists =
      queryAllDeep(
        "[role='listbox'], [role='menu']"
      ).some(isRendered);

    if (popupContainerExists) {
      sawPopup = true;
    }

    const target =
      normalizeText(token);

    const match =
      options.find(option =>
        fuzzyTextMatch(
          normalizeText(
            textOf(option)
          ),
          target
        )
      );

    if (!match) {

      setNativeValue(el, "");

      el.dispatchEvent(
        new Event(
          "input",
          { bubbles: true }
        )
      );

      if (
        i === 0 &&
        !popupContainerExists
      ) {
        // No popup at all for the very first token — this isn't
        // actually this kind of widget.
        return "not_this_widget";
      }

      continue;
    }

    simulateClick(match);
    addedAny = true;

    await new Promise(
      resolve =>
        setTimeout(resolve, 250)
    );

    // Some of these widgets clear the search box themselves after a
    // click; others leave the just-picked text sitting in it, which
    // would otherwise get prefixed onto the next token typed in.
    if (el.value) {
      setNativeValue(el, "");

      el.dispatchEvent(
        new Event(
          "input",
          { bubbles: true }
        )
      );
    }
  }

  el.dispatchEvent(
    new Event(
      "change",
      { bubbles: true }
    )
  );

  el.dispatchEvent(
    new Event(
      "blur",
      { bubbles: true }
    )
  );

  if (addedAny) {
    return "filled";
  }

  return sawPopup
    ? "unfillable"
    : "not_this_widget";
}

/**
 * Fill a single field.
 */
const SUGGESTION_CONTAINER_PATTERN =
  /dropdown|autocomplete|auto-complete|suggest|typeahead|results|listbox|pac-container/i;

/**
 * The suggestion list that belongs to a search-as-you-type text box:
 * an element next to the box (in its field wrapper, not containing the
 * box) whose class says dropdown/autocomplete/suggestions, or the list
 * its aria-controls / aria-owns points at. Null for an ordinary box.
 */
function suggestionContainerFor(
  el: HTMLInputElement
): HTMLElement | null {
  if (!["text", "search", ""].includes(el.type)) {
    return null;
  }

  // Google Places address search: its list (.pac-container) is added at the end of <body>, not next to the box.
  if (el.classList.contains("pac-target-input")) {
    return document.querySelector<HTMLElement>(".pac-container") || null;
  }

  const controls =
    el.getAttribute("aria-controls") ||
    el.getAttribute("aria-owns");

  if (controls) {
    const list = ownerRoot(el).getElementById(controls);

    if (list) {
      return list;
    }
  }

  const wrapper = el.parentElement;

  if (!wrapper) {
    return null;
  }

  return (
    [...wrapper.querySelectorAll<HTMLElement>("*")].find(
      node =>
        !node.contains(el) &&
        SUGGESTION_CONTAINER_PATTERN.test(
          typeof node.className === "string" ? node.className : ""
        )
    ) || null
  );
}

/**
 * Type the value into a search-as-you-type box, wait for its
 * suggestions, and click the best one: the first whose text starts
 * with the value, else the first that contains it. False (and the
 * typed text left in place) when no suggestion matches.
 */
async function fillFromSuggestions(
  el: HTMLInputElement,
  value: string
): Promise<boolean> {
  const container = suggestionContainerFor(el);

  if (!container) {
    return false;
  }

  // A suggestion list rarely knows the whole answer ("Bangalore, India" when it lists "Bangalore"): try the answer,
  // then its part before the first comma, then its first word, as a person narrows a search.
  const queries = [...new Set([
    value.trim(),
    value.split(/[,(]/)[0]!.trim(),
    (value.trim().split(/\s+/)[0] || "").replace(/[,.]$/, "")
  ].filter(q => q.length >= 2))];

  for (const [i, query] of queries.entries()) {
    if (await pickSuggestion(el, container, query, i === queries.length - 1 ? 4000 : 2000)) return true;
  }
  return false;
}

async function pickSuggestion(
  el: HTMLInputElement,
  container: HTMLElement,
  value: string,
  waitMs: number
): Promise<boolean> {
  await typeCharacters(el, value, false);

  const target = normalizeText(value);

  const candidates = (): HTMLElement[] =>
    [...container.querySelectorAll<HTMLElement>("li, [role='option'], div, a, button")]
      .filter(node =>
        node.children.length === 0 ||
        node.getAttribute("role") === "option" ||
        /option|item|location|result|suggest/i.test(
          typeof node.className === "string" ? node.className : ""
        )
      )
      .filter(node => isRendered(node) && textOf(node).length > 0)
      .filter(node => !/no .*found|loading|searching/i.test(textOf(node)));

  for (let waited = 0; waited < waitMs; waited += 250) {
    const options = candidates();
    // Innermost only: the list wrapper (".dropdown-results") holds
    // every suggestion's text too, and clicking it selects nothing.
    const items = options.filter(
      node => !options.some(other => other !== node && node.contains(other))
    );
    const pick =
      items.find(node => normalizeText(textOf(node)).startsWith(target)) ||
      items.find(node => normalizeText(textOf(node)).includes(target));

    if (pick) {
      pick.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      pick.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      pick.click();
      return true;
    }

    await new Promise(resolve => setTimeout(resolve, 250));
  }

  return false;
}

const pause = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function pressKey(el: HTMLElement, key: string): void {
  const init = { key, code: key, bubbles: true, cancelable: true };
  el.dispatchEvent(new KeyboardEvent("keydown", init));
  el.dispatchEvent(new KeyboardEvent("keyup", init));
}

function pointAt(target: EventTarget, type: string, x: number, y: number, buttons: number): void {
  const init = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, buttons, pointerId: 1, pointerType: "mouse", isPrimary: true, pressure: buttons ? 0.5 : 0, view: window };
  const PE = (window as unknown as { PointerEvent?: typeof PointerEvent }).PointerEvent;
  if (type.startsWith("pointer") && PE) target.dispatchEvent(new PE(type, init));
  else target.dispatchEvent(new MouseEvent(type.replace("pointer", "mouse"), init));
}

/**
 * An ARIA slider (role=slider, not a native input): arrow keys from where it is to the value, as a person would;
 * when keys do not move it, a press on its track at the value's place.
 */
async function fillAriaSlider(el: HTMLElement, value: string): Promise<boolean> {
  const target = Number(value);
  if (Number.isNaN(target)) return false;
  const now = () => Number(el.getAttribute("aria-valuenow"));
  const min = Number(el.getAttribute("aria-valuemin") ?? 0);
  const max = Number(el.getAttribute("aria-valuemax") ?? 100);
  el.scrollIntoView({ block: "center", behavior: "auto" });
  el.focus();
  for (let i = 0; i < 400 && now() !== target; i += 1) {
    const before = now();
    pressKey(el, before < target ? "ArrowRight" : "ArrowLeft");
    await pause(0);
    const after = now();
    // Did not move, or stepped past the value (a step that does not land on it): stop here.
    if (after === before || (before < target) !== (after < target)) break;
  }
  if (now() === target) return true;
  // The track: the slider's own box when it is the whole bar, else its parent.
  const track = (el.getBoundingClientRect().width > 40 ? el : el.parentElement) as HTMLElement | null;
  if (!track || max <= min) return false;
  const r = track.getBoundingClientRect();
  const x = r.left + (r.width * (target - min)) / (max - min);
  const y = r.top + r.height / 2;
  for (const t of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) pointAt(track, t, x, y, t.endsWith("down") ? 1 : 0);
  await pause(30);
  return Math.abs(now() - target) <= Math.max(1, (max - min) / 100);
}

/**
 * A signature pad: the name drawn as one pen stroke across the pad (pointer and mouse events, which signature_pad,
 * react-signature-canvas and similar widgets record). Checked by reading the pad's pixels when the page allows it.
 */
async function drawSignature(c: HTMLCanvasElement, name: string): Promise<boolean> {
  c.scrollIntoView({ block: "center", behavior: "auto" });
  const r = c.getBoundingClientRect();
  if (r.width < 20 || r.height < 10) return false;
  const text = name.trim() || "Signed";
  const n = Math.max(24, text.length * 8);
  const pts: Array<[number, number]> = [];
  for (let i = 0; i <= n; i += 1) {
    const t = i / n;
    const code = text.charCodeAt(Math.floor(t * (text.length - 1)));
    const swing = Math.sin(i * 1.1 + code) * (0.18 + (code % 5) * 0.03);
    pts.push([r.left + r.width * (0.12 + 0.76 * t), r.top + r.height * (0.55 + swing)]);
  }
  const [x0, y0] = pts[0]!;
  pointAt(c, "pointerdown", x0, y0, 1);
  pointAt(c, "mousedown", x0, y0, 1);
  for (const [x, y] of pts.slice(1)) {
    pointAt(c, "pointermove", x, y, 1);
    pointAt(c, "mousemove", x, y, 1);
    await pause(0);
  }
  const [x1, y1] = pts[pts.length - 1]!;
  pointAt(c, "pointerup", x1, y1, 0);
  pointAt(c, "mouseup", x1, y1, 0);
  c.dataset.aiSigned = "1";
  try {
    const px = c.getContext("2d")?.getImageData(0, 0, c.width, c.height).data;
    if (px) {
      for (let i = 3; i < px.length; i += 16) if (px[i]! > 0) return true;
      return false;
    }
  } catch {
    // A tainted or WebGL canvas cannot be read: trust the stroke.
  }
  return true;
}

/**
 * The input-type agent's controls on the page (answers already shaped by src/shared/ai-apply/input-kinds.ts):
 * a signature pad, a toggle switch, an ARIA slider or spin button, and native time / datetime / month / week /
 * range / colour inputs, which keep a value only in their exact format (checked after setting). Undefined when
 * the element is none of these: the usual fillers take it.
 */
async function fillSpecialControl(el: HTMLElement, value: string): Promise<boolean | undefined> {
  if (el instanceof HTMLCanvasElement) return drawSignature(el, value);
  const role = el.getAttribute("role");
  const native = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
  if (role === "switch" && !native) {
    const want = /^(yes|true|on|1)$/i.test(value.trim());
    const isOn = () => el.getAttribute("aria-checked") === "true";
    if (isOn() !== want) {
      simulateClick(el);
      await pause(50);
    }
    return isOn() === want;
  }
  if (role === "slider" && !native) return fillAriaSlider(el, value);
  if (role === "spinbutton" && !native) {
    const target = Number(value);
    if (Number.isNaN(target)) return false;
    const now = () => Number(el.getAttribute("aria-valuenow"));
    el.focus();
    for (let i = 0; i < 400 && now() !== target; i += 1) {
      const before = now();
      pressKey(el, before < target ? "ArrowUp" : "ArrowDown");
      await pause(0);
      if (now() === before) break;
    }
    return now() === target;
  }
  if (el instanceof HTMLInputElement && ["time", "datetime-local", "month", "week", "range", "color"].includes(el.type)) {
    fillText(el, value);
    // The browser drops a value in the wrong format and clamps a range: read back what it kept.
    if (el.type === "range") return Math.abs(Number(el.value) - Number(value)) <= Number(el.step || 1);
    return el.value === value || (el.type === "datetime-local" && el.value.startsWith(value));
  }
  return undefined;
}

/** Search boxes that take one value: a place, a school, an employer. Never a tag input, even for "A, B" answers. */
const SINGLE_VALUE_SEARCH =
  /\b(city|town|location|address|locality|state|country|nationality|college|university|school|institute|company|employer|organi[sz]ation|current (city|location))\b/i;

async function fillField(
  id: string,
  value: string,
  label?: string
): Promise<boolean> {

  const chat = naukriChatFill(id, value);
  if (chat !== null) return chat;

  const el =
    findElement(id, label);

  if (!el) {
    return false;
  }

  if (
    !value ||
    value ===
      "NEEDS_USER_INPUT"
  ) {
    return false;
  }

  // Switches, sliders, spin buttons, signature pads, and native time/month/week/range/colour inputs.
  const special = await fillSpecialControl(el, value);
  if (special !== undefined) return special;

  // Radio
  if (
    el instanceof HTMLInputElement &&
    el.type === "radio"
  ) {
    return fillRadio(
      el,
      value
    );
  }

  // Checkbox
  if (
    el instanceof HTMLInputElement &&
    el.type === "checkbox"
  ) {
    return fillCheckboxes(
      el,
      value
    );
  }

  // ARIA radio (Google Forms multiple-
  // choice questions)
  if (
    el.getAttribute("role") ===
      "radio"
  ) {
    return fillAriaRadio(
      el,
      value
    );
  }

  // ARIA checkbox (Google Forms
  // checkbox questions, and standalone
  // consent-style checkboxes)
  if (
    el.getAttribute("role") ===
      "checkbox"
  ) {
    return fillAriaCheckbox(
      el,
      value
    );
  }

  // File
  if (
    el instanceof HTMLInputElement &&
    el.type === "file"
  ) {
    return false;
  }

  // Native select
  if (
    el instanceof HTMLSelectElement
  ) {
    return fillSelect(
      el,
      value
    );
  }

  // Date
  if (
    el instanceof HTMLInputElement &&
    el.type === "date"
  ) {
    return fillDate(
      el,
      value
    );
  }

  // Custom / masked date text field
  // (react-datepicker, MUI, AntD, etc.)
  if (
    el instanceof HTMLInputElement &&
    isDateLikeField(el)
  ) {
    return fillDateText(
      el,
      value
    );
  }

  // Custom combobox
  if (
    isCustomCombobox(el)
  ) {
    return fillCombobox(
      el,
      value
    );
  }

  // Numeric input — a native <input type="number"> silently
  // REJECTS (leaves blank) any value assignment that isn't a valid
  // number, with no error and no visible sign anything went wrong.
  // Profile data is often descriptive text even when the field
  // wants a bare number — "5+" years of experience, "15 days"
  // notice period, "$85,000" — so strip that down to the number
  // itself before writing it. A safety net independent of whether
  // the LLM already returned a clean number (confirmed live: it
  // doesn't always, and a number field failing this way is
  // completely silent — the field just stays empty).
  if (
    el instanceof HTMLInputElement &&
    el.type === "number"
  ) {

    const match =
      value.match(/-?\d+(\.\d+)?/);

    return fillText(
      el,
      match ? match[0] : value
    );
  }

  // A one-value search box (city, location, address, college, company) whose answer has a comma ("Bangalore,
  // India"): it is not a tag input. Taken for one, the answer went in as two tags and the box ended empty
  // (input-types fixture, 2026-11-06). Pick from its suggestions first.
  if (
    el instanceof HTMLInputElement &&
    value.includes(",") &&
    SINGLE_VALUE_SEARCH.test(label || getLabel(el) || "") &&
    suggestionContainerFor(el) &&
    await fillFromSuggestions(el, value)
  ) {
    return true;
  }

  // Multi-value tag/chip input (e.g. Workday's "Type to Add
  // Skills") — tried before the plain text fallback since a normal
  // text field with a comma in its answer will simply find no
  // popup on the first token and report "not_this_widget" unchanged.
  if (
    el instanceof HTMLInputElement &&
    value.includes(",")
  ) {

    const result =
      await fillMultiValueTagInput(
        el,
        value
      );

    if (result === "filled") {
      return true;
    }

    // A real popup answered but nothing could be matched into it —
    // this field genuinely needs a person, not a raw paste that
    // would just leave it in a broken half-typed state.
    if (result === "unfillable") {
      return false;
    }
  }

  // A search-as-you-type box (Lever's "Current location", many
  // city/college pickers): it keeps only a value picked from its own
  // suggestion list and clears plain typed text.
  if (
    el instanceof HTMLInputElement &&
    suggestionContainerFor(el)
  ) {
    if (await fillFromSuggestions(el, value)) {
      return true;
    }
  }

  // Text / textarea / number / email / etc.
  if (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement
  ) {
    return fillText(
      el,
      value
    );
  }

  // Contenteditable
  if (
    el.getAttribute(
      "contenteditable"
    ) === "true"
  ) {

    el.textContent =
      value;

    el.dispatchEvent(
      new InputEvent(
        "input",
        {
          bubbles: true,
          inputType:
            "insertText",
          data:
            value
        }
      )
    );

    return true;
  }

  return false;
}

/**
 * Resume upload.
 */
/**
 * Fill a Google Forms file-upload
 * question by selecting an existing
 * file from the "Recent" tab of
 * Google's own Picker dialog — Forms
 * has no native file input to attach a
 * File object to directly. Confirmed
 * live: "Add file" opens a Picker
 * widget inside an embedded,
 * same-origin docs.google.com/picker
 * iframe; that iframe DOES contain a
 * real <input type="file">, but setting
 * it programmatically (the same
 * DataTransfer technique that works for
 * every normal ATS file input) did not
 * reliably register as a real answer to
 * the form's own question — picking an
 * already-uploaded file from "Recent"
 * is the realistic, human-shaped path
 * instead. This is inherently more
 * fragile than every other fill
 * strategy here, since it depends on
 * Google's own Picker UI structure,
 * which isn't a documented, stable
 * target for outside code — a failure
 * here doesn't necessarily mean
 * anything else is broken.
 */
/**
 * Try uploading the candidate's actual saved file directly through
 * the Picker's own "Upload" tab, so what gets attached is exactly
 * what's in the profile rather than a guess at some existing Drive
 * file. Confirmed live this CAN work — setting .files via
 * DataTransfer on the tab's native file input and dispatching
 * input/change occasionally causes the picker to process the
 * upload and auto-close, attaching the file to the form question
 * directly. Also confirmed live it isn't reliable (roughly 1 in 3
 * attempts in testing, no observable difference in the failing
 * cases) — the picker's own upload handler seems to sometimes
 * ignore a script-dispatched change event. So this is tried
 * opportunistically and its success is VERIFIED by watching the
 * picker dialog actually disappear, never assumed from the dispatch
 * alone; the caller falls back to Recent-tab matching when this
 * returns false.
 */
async function tryUploadIntoPicker(
  pickerDoc: Document,
  buffer: ArrayBuffer,
  fileName: string,
  fileType: string
): Promise<boolean> {

  const uploadTab =
    Array.from(
      pickerDoc.querySelectorAll<HTMLElement>(
        "[role='tab']"
      )
    ).find(tab =>
      /upload/i.test(textOf(tab))
    );

  if (uploadTab) {

    simulateClick(uploadTab);

    await new Promise(
      resolve =>
        setTimeout(resolve, 400)
    );
  }

  const fileInput =
    pickerDoc.querySelector<HTMLInputElement>(
      "input[type='file']"
    );

  if (!fileInput) {
    return false;
  }

  const file =
    new File(
      [buffer],
      fileName,
      {
        type:
          fileType ||
          "application/pdf"
      }
    );

  const transfer =
    new DataTransfer();

  transfer.items.add(file);

  fileInput.files =
    transfer.files;

  fileInput.dispatchEvent(
    new Event(
      "input",
      { bubbles: true }
    )
  );

  fileInput.dispatchEvent(
    new Event(
      "change",
      { bubbles: true }
    )
  );

  for (
    let attempt = 0;
    attempt < 12;
    attempt++
  ) {

    await new Promise(
      resolve =>
        setTimeout(resolve, 400)
    );

    const stillOpen =
      queryAllDeep("iframe").some(
        frame =>
          (
            (frame as HTMLIFrameElement)
              .src || ""
          ).includes("/picker")
      );

    if (!stillOpen) {
      return true;
    }
  }

  return false;
}

async function fillGoogleFormsFilePicker(
  trigger: HTMLElement,
  fileName: string,
  buffer?: ArrayBuffer,
  fileType?: string
): Promise<boolean> {

  simulateClick(trigger);

  let pickerFrame:
    HTMLIFrameElement | null = null;

  for (
    let attempt = 0;
    attempt < 15 && !pickerFrame;
    attempt++
  ) {

    await new Promise(
      resolve =>
        setTimeout(resolve, 200)
    );

    pickerFrame =
      (
        queryAllDeep(
          "iframe"
        ) as HTMLIFrameElement[]
      ).find(frame =>
        (frame.src || "").includes(
          "/picker"
        )
      ) || null;
  }

  if (!pickerFrame) {
    return false;
  }

  let pickerDoc: Document | null = null;

  try {
    pickerDoc =
      pickerFrame.contentDocument;
  } catch {
    return false;
  }

  if (!pickerDoc) {
    return false;
  }

  if (buffer) {

    const uploaded =
      await tryUploadIntoPicker(
        pickerDoc,
        buffer,
        fileName,
        fileType || "application/pdf"
      );

    if (uploaded) {
      return true;
    }

    // The upload attempt didn't pan out and left the picker sitting
    // open on the Upload tab (confirmed live: it does not clear
    // itself back to a fresh state) — re-find it fresh rather than
    // reuse pickerDoc, and explicitly switch to Recent before
    // reading candidates below.
    pickerFrame =
      (
        queryAllDeep(
          "iframe"
        ) as HTMLIFrameElement[]
      ).find(frame =>
        (frame.src || "").includes(
          "/picker"
        )
      ) || null;

    if (!pickerFrame) {
      return false;
    }

    try {
      pickerDoc =
        pickerFrame.contentDocument;
    } catch {
      return false;
    }

    if (!pickerDoc) {
      return false;
    }
  }

  const recentTab =
    Array.from(
      pickerDoc.querySelectorAll<HTMLElement>(
        "[role='tab']"
      )
    ).find(tab =>
      /recent/i.test(textOf(tab))
    );

  if (recentTab) {

    simulateClick(recentTab);

    await new Promise(
      resolve =>
        setTimeout(resolve, 600)
    );
  }

  // Deliberately not limited to items whose VISIBLE text ends in a
  // recognized extension — confirmed live: a saved cover letter can
  // sit in Drive as a native Google Doc with no extension in its
  // name at all ("Mahendra_Cover_Letter"), which the old extension-
  // only filter silently excluded from consideration entirely.
  // Every rendered option/button is a candidate; the fuzzy name
  // match below is what actually decides relevance.
  const candidates =
    Array.from(
      pickerDoc.querySelectorAll<HTMLElement>(
        "[role='option'], [role='button']"
      )
    ).filter(el => isRendered(el));

  if (candidates.length === 0) {
    return false;
  }

  const target =
    normalizeText(fileName);

  const match =
    candidates.find(candidate =>
      fuzzyTextMatch(
        normalizeText(
          textOf(candidate)
        ),
        target
      )
    );

  // No confident match — a saved resume/cover letter that was never
  // manually uploaded to Drive under a recognizable name has no
  // honest candidate here. Attaching the WRONG document (falling
  // back to "whatever's first in the list") would be worse than
  // leaving the field empty and letting the normal
  // required-field/QA-report path surface it instead.
  if (!match) {
    return false;
  }

  simulateClick(match);

  await new Promise(
    resolve =>
      setTimeout(resolve, 600)
  );

  return true;
}

// Shared by fillResume() and the Browser Agent's "upload_file"
// action — both ultimately need to hand a File to a native
// <input type="file"> the same way a person's own file picker
// would, via a DataTransfer (the only way to script-assign
// `.files` on a real file input).
function assignFileToInput(
  el: HTMLInputElement,
  buffer: ArrayBuffer,
  fileName: string,
  fileType: string
): void {

  const file =
    new File(
      [buffer],
      fileName,
      {
        type:
          fileType ||
          "application/octet-stream"
      }
    );

  const transfer =
    new DataTransfer();

  transfer.items.add(
    file
  );

  el.files =
    transfer.files;

  el.dispatchEvent(
    new Event(
      "input",
      { bubbles: true }
    )
  );

  el.dispatchEvent(
    new Event(
      "change",
      { bubbles: true }
    )
  );
}

async function fillResume(
  id: string,
  buffer: ArrayBuffer,
  fileName: string,
  fileType: string,
  label?: string
): Promise<boolean> {

  // Unlike every other field type (see FILL_FIELDS's
  // answersWithLabel), the resume/cover-letter upload never passed
  // its own label through, so it had none of the ordinary
  // id-regenerated-on-re-render resilience the rest of the app
  // relies on (findElement falls back to a label-based lookup —
  // findElementByLabel — the moment the id captured at extraction
  // time no longer resolves). Confirmed live via the QA report: a
  // very high share of "Could not attach the saved resume" failures
  // across many different, otherwise-working sites (including plain
  // LinkedIn Easy Apply, whose native file input is normally
  // reliable) — exactly the shape of an id going stale between the
  // extract and fill steps with no fallback to catch it.
  const el =
    findElement(id, label);

  if (!el) {
    return false;
  }

  if (
    !(el instanceof HTMLInputElement) ||
    el.type !== "file"
  ) {
    return fillGoogleFormsFilePicker(
      el,
      fileName,
      buffer,
      fileType
    );
  }

  assignFileToInput(
    el,
    buffer,
    fileName,
    fileType || "application/pdf"
  );

  return true;
}

function findContinueButton(): HTMLElement | null {

  // Naukri's chatbot: "Save" sends this answer and brings the next question.
  if (naukriChatRoot()) return naukriChatSave();

  const agree = findTermsAgreeButton();
  if (agree) return agree;

  const elements =
    queryAllDeep(
      "button, input[type='button'], input[type='submit'], a",
      getStepRoot()
    );

  const patterns = [
    "next",
    "continue",
    "save & continue",
    "save and continue",
    "proceed",
    "next step",
    // A step whose only advancing control
    // is labelled "Review" (confirmed on
    // LinkedIn's Easy Apply, whose last
    // question page before the actual
    // review screen uses this exact
    // label instead of "Next") — treat it
    // the same as Continue. Clicking it
    // only opens the review/summary
    // screen, never submits, so it's the
    // same non-destructive step-advance as
    // Next; without it here the agent
    // mistakes reaching this page for a
    // dead end and stops one step short of
    // the real Submit-only screen it's
    // supposed to reach and pause at.
    "review"
  ];

  return (
    elements.find(el => {

      // See isRendered() note in the other
      // button-finders below — offsetParent
      // misses position:fixed sticky nav
      // bars, a common cause of "no Next
      // button found" on a step that
      // genuinely has one.
      if (
        !isRendered(el)
      ) {
        return false;
      }

      const text =
        (
          el.innerText ||
          el.getAttribute(
            "value"
          ) ||
          ""
        )
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();

      return patterns.some(
        pattern =>
          text === pattern ||
          text.startsWith(
            `${pattern} `
          ) ||
          text.startsWith(
            `${pattern}:`
          )
      );
    }) ||
    null
  );
}

/**
 * Find the terminal "Submit
 * Application" style button, distinct
 * from a Next/Continue button — used by
 * the auto-apply loop to recognize it
 * has reached the final page.
 */
/**
 * A form's own last button that says Apply (Keka: "Apply Now" under the application form, QA 2026-11-05): a submit
 * button inside a form of 2+ visible fields. A job page's Apply button is not in such a form, so it never counts.
 */
function findFormApplySubmit(): HTMLElement | null {
  const buttons = queryAllDeep("button, input[type='submit']", getStepRoot()) as HTMLElement[];
  return buttons.find(b => {
    if (!isRendered(b)) return false;
    const text = ((b.innerText || b.getAttribute("value") || "").replace(/\s+/g, " ").trim()).toLowerCase();
    if (!/^(apply|apply now|submit now|send|apply for this job|submit my application)$/.test(text)) return false;
    const form = b.closest("form");
    if (!form) return false;
    const fields = [...form.querySelectorAll("input:not([type='hidden']):not([type='submit']):not([type='button']), textarea, select")].filter(el => isRendered(el as HTMLElement));
    return fields.length >= 2;
  }) || null;
}

function findSubmitButton(): HTMLElement | null {

  // The chatbot has no Submit: Naukri applies once the last question is answered.
  if (naukriChatRoot()) return null;

  const elements =
    queryAllDeep(
      "button, input[type='button'], input[type='submit'], a",
      getStepRoot()
    );

  const patterns = [
    "submit",
    "submit application",
    "finish",
    "finish application",
    "complete application",
    "send application"
  ];

  return (
    elements.find(el => {

      // offsetParent is null for
      // position:fixed elements even when
      // they're fully visible — a sticky
      // bottom nav bar (common for multi-
      // step forms/modals) would be
      // treated as invisible and silently
      // skipped, which reads as "no
      // Next/Submit button found" even
      // though one is right there.
      // getClientRects (isRendered) stays
      // accurate for position:fixed.
      if (!isRendered(el)) {
        return false;
      }

      const text =
        (
          el.innerText ||
          el.getAttribute(
            "value"
          ) ||
          ""
        )
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();

      return patterns.some(
        pattern =>
          text === pattern ||
          text.startsWith(
            `${pattern} `
          )
      );
    }) ||
    findFormApplySubmit()
  );
}

/**
 * Find the CTA that starts an
 * application from a job posting page
 * ("Apply", "Apply Now", "Start
 * Application") — distinct from the
 * terminal submit button, and only
 * meaningful before any application
 * fields have been found yet.
 */
function findApplyButton(): HTMLElement | null {

  // If an application modal is already
  // open (the user opened it themselves
  // before running the agent, or an
  // earlier step left it open), there is
  // nothing to "start" — and searching
  // the whole page here is unsafe: the
  // original CTA behind the modal
  // (confirmed live to still count as
  // offsetParent-visible, since an open
  // modal typically marks its background
  // aria-hidden rather than actually
  // hiding it from layout) would get
  // found and clicked again, re-triggering
  // or disrupting the in-progress
  // application before extraction ever
  // gets a stable DOM to read from.
  const dialog = findActiveDialog();
  if (dialog) {
    // Workday's "Start Your Application" chooser (seen 2026-11-05): "Apply Manually" leads to the form; the other
    // choices need a resume upload or an earlier application on that site. Any other open dialog: nothing to start.
    return [...dialog.querySelectorAll<HTMLElement>("button, a, [role='button']")]
      .find(b => isRendered(b) && (b.getAttribute("data-automation-id") === "applyManually" || /^apply manually$/i.test((b.innerText || "").trim()))) || null;
  }

  const list = applyCandidates();
  // Only a clear winner: two close, different candidates go to the AI with the full list (flow.ts, aiFindApply).
  const best = pickClearApplyCandidate(list.map(c => c.desc));
  return best >= 0 ? list[best]!.el : null;
}

/**
 * Every visible control on the page that could open the application (buttons, links, role=button), outside the
 * site's header/nav/footer, deduplicated, page order. Scored by src/shared/ai-apply/apply-button.ts; when nothing
 * scores high enough, the flow shows the top of this list to the AI (APPLY_CANDIDATES).
 */
const APPLY_CANDIDATE_SELECTOR =
  "button, a[href], [role='button'], [role='link'], input[type='button'], input[type='submit']";

function applyCandidateDesc(el: HTMLElement): ApplyCandidate {
  const attr = (n: string) => el.getAttribute(n) || "";
  const href = el instanceof HTMLAnchorElement ? el.href : (el.closest("a[href]") as HTMLAnchorElement | null)?.href || "";
  return {
    text: (el.innerText || (el as HTMLInputElement).value || "").replace(/\s+/g, " ").trim().slice(0, 120),
    label: `${attr("aria-label")} ${attr("title")}`.trim(),
    attrs: [el.id, typeof el.className === "string" ? el.className : "", attr("name"), attr("data-automation-id"), attr("data-testid"), attr("data-ph-at-id")].join(" "),
    href
  };
}

/** The http(s) address of a link that opens in a new tab (the control itself, or the link around it), or null. */
function newTabLinkHref(el: HTMLElement): string | null {
  const a = (el instanceof HTMLAnchorElement ? el : el.closest("a[href]")) as HTMLAnchorElement | null;
  if (!a || !/^https?:/i.test(a.href)) return null;
  const target = (a.getAttribute("target") || "").toLowerCase();
  if (!target || target === "_self" || target === "_top" || target === "_parent") return null;
  // A link to this same page (#apply) is a scroll or a script hook, not a new page.
  const u = new URL(a.href);
  if (u.origin + u.pathname === location.origin + location.pathname && u.hash) return null;
  return a.href;
}

function applyCandidates(): Array<{ el: HTMLElement; desc: ApplyCandidate }> {
  const seen = new Set<HTMLElement>();
  const out: Array<{ el: HTMLElement; desc: ApplyCandidate }> = [];
  for (const el of queryAllDeep(APPLY_CANDIDATE_SELECTOR) as HTMLElement[]) {
    if (seen.has(el) || !isRendered(el)) continue;
    // A <button> inside an <a> (or the reverse) is one control: keep the outer one.
    const outer = el.parentElement?.closest(APPLY_CANDIDATE_SELECTOR) as HTMLElement | null;
    if (outer && seen.has(outer)) continue;
    seen.add(el);
    if ((el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true") continue;
    // Site navigation and footers: "Careers", "Search jobs", "Sign in". Not the posting's own Apply.
    if (el.closest("nav, footer, [role='navigation'], [role='contentinfo'], [role='search']")) continue;
    out.push({ el, desc: applyCandidateDesc(el) });
  }
  return out;
}

/** Up to `max` plausible controls for the AI to choose from: anything with text, never a look-alike that scores below 0. */
const MAX_AI_APPLY_CHOICES = 30;
let aiApplyChoices: HTMLElement[] = [];

function listApplyChoices(): ApplyCandidate[] {
  const list = applyCandidates().filter(c => {
    const shown = (c.desc.text || c.desc.label || "").trim();
    return shown.length > 0 && shown.length <= 80 && scoreApplyCandidate(c.desc) >= 0;
  });
  // Likeliest first, so a long page's real button is not cut off by the limit.
  list.sort((a, b) => scoreApplyCandidate(b.desc) - scoreApplyCandidate(a.desc));
  const top = list.slice(0, MAX_AI_APPLY_CHOICES);
  aiApplyChoices = top.map(c => c.el);
  return top.map(c => c.desc);
}

/**
 * Is this field part of a form that is not the application: a job-alert sign-up, newsletter, talent community,
 * "email this job"? Read from the field's own id/name and up to 8 ancestors' ids, classes and aria-labels (Target's
 * fields sit in div#job-alert-signup-form, seen 2026-11-06), plus the first heading of its <form>. Stops at an open
 * dialog, so a modal's own name decides only when the field is inside it.
 */
function isInSideForm(el: Element, dialog: HTMLElement | null): boolean {
  const parts: string[] = [el.id, el.getAttribute("name") || ""];
  let node: Element | null = el.parentElement;
  for (let i = 0; node && i < 8 && node !== document.body; i += 1, node = node.parentElement) {
    parts.push(node.id, typeof node.className === "string" ? node.className : "", node.getAttribute("aria-label") || "", node.getAttribute("data-testid") || "");
    if (node === dialog) break;
  }
  const form = el.closest("form");
  if (form) parts.push(form.getAttribute("name") || "", form.getAttribute("action") || "", form.querySelector("h1, h2, h3, h4, legend")?.textContent || "");
  return isSideFormContext(parts.join(" "));
}

/**
 * Find the button that submits an
 * account-creation / signup form,
 * distinct from the job application's
 * own Next/Submit buttons.
 */
function findAccountCreateButton(): HTMLElement | null {

  const elements =
    queryAllDeep(
      "button, input[type='button'], input[type='submit'], a",
      getStepRoot()
    );

  const patterns = [
    "create account",
    "sign up",
    "sign me up",
    "register",
    "create profile",
    "get started",
    "create my account"
  ];

  const bespoke =
    elements.find(el => {

      // offsetParent is null for
      // position:fixed elements even when
      // they're fully visible — a sticky
      // bottom nav bar (common for multi-
      // step forms/modals) would be
      // treated as invisible and silently
      // skipped, which reads as "no
      // Next/Submit button found" even
      // though one is right there.
      // getClientRects (isRendered) stays
      // accurate for position:fixed.
      if (!isRendered(el)) {
        return false;
      }

      const text =
        (
          el.innerText ||
          el.getAttribute("value") ||
          ""
        )
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();

      return patterns.some(
        pattern =>
          text === pattern ||
          text.startsWith(`${pattern} `)
      );
    }) ||
    null;

  if (bespoke) {
    return bespoke;
  }

  // Not every account-gate step uses
  // bespoke "Create Account"-style
  // wording — confirmed live (QA report):
  // an iCIMS step whose real button said
  // "Submit Profile" and a Michael Page
  // step whose real link said "Submit
  // your CV" were both reported as "no
  // recognizable Create Account/Sign Up
  // button" even though the ordinary
  // Next/Submit search on the very same
  // page found and would have used them
  // fine. Whatever a password field on
  // this step is actually for, a
  // Next/Continue/Submit-style button is
  // still the correct way to move past
  // it — reuse the already-proven general
  // button finders instead of requiring
  // this narrower pattern list to also
  // predict every site's wording.
  return (
    findContinueButton() ||
    findSubmitButton()
  );
}

/**
 * Whether this page is asking to
 * create an account (has a visible
 * password field) rather than being
 * the application form itself.
 */
function findPasswordFields(): HTMLInputElement[] {

  return queryAllDeep(
    "input[type='password']"
  ).filter(
    (el): el is HTMLInputElement =>
      el instanceof HTMLInputElement &&
      isRendered(el)
  );
}

/**
 * Heuristic check for an email
 * verification / OTP gate — a short
 * numeric code field, or page text
 * asking to check email / enter a
 * code, appearing right after an
 * account was just created.
 */
function looksLikeVerificationGate(): boolean {

  const bodyText =
    textOf(document.body)
      .toLowerCase()
      .slice(0, 3000);

  const textMatch =
    /verification code|verify your email|check your email|enter the code|one[-\s]?time (code|password)|otp\b/.test(
      bodyText
    );

  if (textMatch) {
    return true;
  }

  const shortNumericInput =
    queryAllDeep(
      "input[type='text'], input[type='tel'], input[type='number'], input:not([type])"
    ).some(el => {

      if (
        !(el instanceof HTMLInputElement) ||
        !isRendered(el)
      ) {
        return false;
      }

      const hints =
        [
          el.getAttribute("placeholder"),
          el.getAttribute("aria-label"),
          el.getAttribute("name"),
          el.id,
          getLabel(el)
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();

      return /verification|otp|one[-\s]?time|code/.test(
        hints
      );
    });

  return shortNumericInput;
}

/**
 * Scan for visible validation-error
 * text near fields, after a fill
 * attempt — role=alert / aria-invalid
 * / common "error" class names —
 * associated back to the nearest field
 * by aria-describedby or DOM proximity.
 */
/** Where forms write a field's error: ARIA, common class names, MUI, Ant Design, Bootstrap, Greenhouse, Lever, Workday. */
const ERROR_TEXT_SELECTOR = [
  "[role='alert']", "[aria-live='assertive']", ".error", ".errors", ".field-error", ".error-message", ".error-msg", ".error-text",
  ".invalid-feedback", ".help-block.error", ".has-error .help-block", ".Mui-error.MuiFormHelperText-root", ".ant-form-item-explain-error",
  ".form-error", ".input-error", ".validation-error", ".validation-message", ".field-validation-error", ".parsley-errors-list li",
  "[data-error]", "[class*='errorMessage']", "[class*='error-message' i]", "[class*='ErrorMessage']", "[class*='field-error' i]",
  "[data-automation-id='errorMessage']", "[id$='-error' i]", "[id$='_error' i]", "[id$='Error']"
].join(", ");

/** A field's wrapper: the smallest box around one question that also holds its error text. */
const FIELD_BOX_SELECTOR =
  "fieldset, [role='group'], [role='radiogroup'], .form-group, .form-field, .form-item, .field, .question, " +
  "[class*='form-group' i], [class*='form-field' i], [class*='formField'], [class*='FormControl'], [class*='form-item' i], " +
  "[class*='question' i], [class*='field-wrapper' i], [class*='input-wrapper' i], [data-automation-id], li, label";

const FIELD_SELECTOR = "input:not([type='hidden']):not([type='submit']):not([type='button']), select, textarea, [role='combobox'], [role='textbox'], [role='switch'], [role='slider'], [role='radio'], [role='checkbox']";

/** Text that reads like an error, not a hint ("Max 500 characters" under an empty box is a hint, not an error). */
const ERROR_WORDS =
  /required|invalid|valid |not valid|please|must|cannot|can't|should|enter|select|choose|too (long|short)|at (most|least)|maximum|minimum|exceed|format|match|only|error|missing|incorrect|wrong|already/i;

/**
 * The page's validation errors (DETECT_ERRORS), for the error-fix agent (src/shared/ai-apply/error-fix.ts):
 *  - the browser's own validation (validationMessage) of every field on the step: "Please enter an email address",
 *    "Value must be less than or equal to 40", "Please match the requested format";
 *  - error text the page shows, tied to its field through aria-errormessage / aria-describedby, else through the
 *    smallest wrapper that holds one field (a form group, fieldset, question box);
 *  - fields marked aria-invalid with no text of their own;
 *  - page-level banners ("Please correct the errors below") that belong to no field, in `page`.
 * Each field error carries the field's current value, so a fix starts from what is really in the box.
 */
function detectFieldErrors(): Array<{ field_id: string; message: string; value: string }> {
  return detectPageErrors().errors;
}

function detectPageErrors(): { errors: Array<{ field_id: string; message: string; value: string }>; page: string[] } {
  const root = getStepRoot();
  const results: Array<{ field_id: string; message: string; value: string }> = [];
  const byId = new Map<string, number>();
  const page: string[] = [];
  const valueOf = (el: HTMLElement) =>
    el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement ? el.value : (el.getAttribute("aria-valuenow") || textOf(el) || "");
  const add = (el: HTMLElement, message: string) => {
    // A radio/checkbox group answers as one field: report it once, on its first box.
    let target = el;
    if (el instanceof HTMLInputElement && (el.type === "radio" || el.type === "checkbox") && el.name) {
      target = (ownerRoot(el).querySelector(`input[name="${cssString(el.name)}"]`) as HTMLElement | null) || el;
    }
    const id = ensureId(target, results.length);
    const text = message.replace(/\s+/g, " ").trim().slice(0, 300);
    if (!text) return;
    const at = byId.get(id);
    if (at !== undefined) {
      // A page's own text says more than the browser's generic message: keep the more specific one.
      if (results[at]!.message === "This field failed validation." || results[at]!.message.length < 8) results[at]!.message = text;
      return;
    }
    byId.set(id, results.length);
    results.push({ field_id: id, message: text, value: valueOf(target) });
  };
  const fieldsIn = (box: Element) =>
    [...box.querySelectorAll<HTMLElement>(FIELD_SELECTOR)].filter(f => isRendered(f) && !isHoneypot(f));
  const oneFieldOf = (box: Element): HTMLElement | null => {
    const fields = fieldsIn(box);
    if (!fields.length) return null;
    // A radio/checkbox group is one question.
    const names = new Set(fields.map(f => (f instanceof HTMLInputElement && (f.type === "radio" || f.type === "checkbox") && f.name ? `g:${f.name}` : f)));
    return names.size === 1 ? fields[0]! : null;
  };

  // 1. Error text on the page.
  const texts = queryAllDeep(ERROR_TEXT_SELECTOR, root).filter(el => isRendered(el) && !(el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement));
  // Innermost only: a wrapper ".errors" holding a ".error" would repeat it.
  const inner = texts.filter(el => !texts.some(o => o !== el && el.contains(o)));
  for (const el of inner) {
    const message = textOf(el).replace(/\s+/g, " ").trim();
    if (!message || message.length > 300 || !ERROR_WORDS.test(message)) continue;
    let field: HTMLElement | null = null;
    if (el.id) {
      field = (queryAllDeep(FIELD_SELECTOR, root) as HTMLElement[]).find(f =>
        [f.getAttribute("aria-errormessage"), f.getAttribute("aria-describedby")].some(v => !!v && v.split(/\s+/).includes(el.id))
      ) || null;
    }
    // The error's own box, growing outwards until it holds a field: then it is that field's error only if the box
    // holds exactly one question.
    for (let box: Element | null = el.parentElement, hops = 0; !field && box && box !== document.body && hops < 6; box = box!.parentElement, hops += 1) {
      if (!fieldsIn(box).length) continue;
      if (box.matches(FIELD_BOX_SELECTOR) || hops <= 2) field = oneFieldOf(box);
      break;
    }
    if (field) add(field, message);
    else if (!page.includes(message)) page.push(message);
  }

  // 2. The browser's own validation, and aria-invalid with no message.
  for (const el of queryAllDeep(FIELD_SELECTOR, root) as HTMLElement[]) {
    if (!isRendered(el) || isHoneypot(el) || el.closest(SITE_CHROME_SELECTOR)) continue;
    const native = el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement;
    if (native && !(el as HTMLInputElement).disabled && (el as HTMLInputElement).willValidate && !(el as HTMLInputElement).checkValidity()) {
      add(el, (el as HTMLInputElement).validationMessage || "This field failed validation.");
    } else if (el.getAttribute("aria-invalid") === "true") {
      add(el, "This field failed validation.");
    }
  }

  // An "errors below" banner with errors already tied to fields says nothing more.
  return { errors: results, page: results.length ? page.filter(p => !/below|above|highlighted|errors? (on|in) (the|this) (form|page)/i.test(p)) : page };
}

/**
 * A rich, read-only snapshot of the
 * page's actual current state, captured
 * at the moment something went wrong —
 * this is what the QA agent uses to
 * hypothesize a root cause instead of
 * just relaying the filling agent's own
 * one-line status message. It mirrors
 * exactly the kind of manual DOM
 * inspection that found every real bug
 * in this codebase so far (a pagination
 * button winning over the modal's real
 * Next button because it wasn't scoped
 * to the open dialog; a validation error
 * that never mapped back to any actual
 * field; a click landing off-screen) —
 * automated here instead of requiring a
 * live reproduction each time.
 */
function captureDiagnosticSnapshot(): Record<
  string,
  unknown
> {

  const dialog = findActiveDialog();

  const allDialogs =
    queryAllDeep(
      DIALOG_SELECTOR
    ).filter(isRendered);

  const buttonLikeSiteWide =
    queryAllDeep(
      "button, input[type='button'], input[type='submit'], a"
    ).filter(isRendered);

  const describeButton = (
    el: HTMLElement
  ) => ({
    text:
      (
        el.innerText ||
        el.getAttribute("value") ||
        ""
      )
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 60),
    tag: el.tagName,
    testId:
      el.getAttribute(
        "data-testid"
      ) || undefined,
    insideActiveDialog:
      !!dialog &&
      dialog.contains(el)
  });

  const nextPattern =
    /^(next|continue|save & continue|save and continue|proceed|next step|review)(\s|:|$)/i;

  const submitPattern =
    /^(submit|submit application|finish|finish application|complete application|send application)(\s|$)/i;

  const buttonText = (
    el: HTMLElement
  ) =>
    (
      el.innerText ||
      el.getAttribute("value") ||
      ""
    ).trim();

  const nextCandidatesSiteWide =
    buttonLikeSiteWide
      .filter(el =>
        nextPattern.test(
          buttonText(el)
        )
      )
      .map(describeButton)
      .slice(0, 8);

  const submitCandidatesSiteWide =
    buttonLikeSiteWide
      .filter(el =>
        submitPattern.test(
          buttonText(el)
        )
      )
      .map(describeButton)
      .slice(0, 8);

  const errors = detectFieldErrors();

  const allInteractiveFields =
    queryAllDeep(
      [
        "input:not([type='hidden'])",
        "textarea",
        "select",
        "[role='textbox']",
        "[role='combobox']",
        "[aria-haspopup='listbox']",
        "[aria-haspopup='menu']",
        "[aria-haspopup='true']",
        "[role='radio']",
        "[role='checkbox']",
        "[role='listbox']"
      ].join(",")
    ).filter(isRendered);

  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    dialogOpen: !!dialog,
    dialogClass:
      dialog
        ? (dialog.className || "")
            .toString()
            .slice(0, 100)
        : null,
    totalDialogsFound:
      allDialogs.length,
    totalInteractiveFieldsFound:
      allInteractiveFields.length,
    validationErrorsFound:
      errors.length,
    nextButtonFoundScoped:
      !!findContinueButton(),
    submitButtonFoundScoped:
      !!findSubmitButton(),
    // If either candidate list below
    // has an entry with
    // insideActiveDialog: false while
    // a dialog IS open, that's a
    // strong signal of exactly the
    // pagination-button-style
    // ambiguity that caused the
    // original LinkedIn bug — a
    // page-wide "Next"/"Submit" match
    // unrelated to the actual
    // application.
    nextButtonCandidatesSiteWide:
      nextCandidatesSiteWide,
    submitButtonCandidatesSiteWide:
      submitCandidatesSiteWide,
    iframeCount:
      queryAllDeep("iframe").length
  };
}

// ---------------------------------------------------------------
// Browser agent — a generic "read the page, take one action" layer
// for the free-form "do this task on the current tab" agent, as
// opposed to extractForm()'s job-application-specific field
// extraction. Reuses the same shadow-DOM-safe traversal, id-minting,
// and click/type primitives already built for the form-filling
// agent rather than duplicating them.
// ---------------------------------------------------------------

type AgentElement = {
  id: string;
  role: string;
  text: string;
  value: string;

  // Nearby readable text (a post's body, a card's caption, a
  // comment thread) — how the agent "reads" page content, since an
  // icon-only control (Like, Repost, a 3-dot menu) carries no
  // content of its own to judge relevance by. Only populated for
  // elements whose own text is short/generic, since a repeating
  // feed of cards can put the same context on many nearby elements
  // otherwise — see agentElementContext().
  context: string;

  // The resolved absolute URL for an <a href> element, empty for
  // everything else — how the agent answers "give me the link to
  // X" instructions: it can only ever report a URL it actually read
  // off the page this way, never invent one.
  href: string;
};

const AGENT_ELEMENT_SELECTOR = [
  "button",
  "a[href]",
  "input:not([type='hidden'])",
  "textarea",
  "select",
  "[contenteditable='true']",
  "[role='button']",
  "[role='link']",
  "[role='menuitem']",
  "[role='menuitemcheckbox']",
  "[role='option']",
  "[role='tab']",
  "[role='checkbox']",
  "[role='radio']",
  "[role='switch']",
  "[role='textbox']",
  "[role='combobox']"
].join(",");

// Cap how many elements get sent to the LLM per step — a feed-style
// page (LinkedIn, Twitter) can have hundreds of buttons/links, and
// most of them are irrelevant to any single instruction. Elements
// currently inside (or close to) the viewport are what a person
// would actually be looking at, so those are kept first; anything
// beyond the cap is dropped rather than truncated arbitrarily by
// DOM order, which would bias toward whatever happens to be first
// in the markup instead of what's visible.
const MAX_AGENT_ELEMENTS = 200;

function agentElementRole(
  el: HTMLElement
): string {

  const explicitRole =
    el.getAttribute("role");

  if (explicitRole) {
    return explicitRole;
  }

  const tag =
    el.tagName.toLowerCase();

  if (tag === "a") {
    return "link";
  }

  if (tag === "textarea") {
    return "textbox";
  }

  if (tag === "select") {
    return "combobox";
  }

  if (
    el.getAttribute(
      "contenteditable"
    ) === "true"
  ) {
    return "textbox";
  }

  if (
    el instanceof HTMLInputElement
  ) {
    return el.type || "textbox";
  }

  return tag;
}

// Zero-width space/joiner/no-break-space characters — used by some
// icon-only buttons as an invisible placeholder for layout purposes
// (confirmed live: LinkedIn's post "Repost" button has an
// aria-label of "Repost" but a literal U+200B zero-width space as
// its actual text content). \s in a regex does NOT match these, so
// they survive a normal .trim() as a non-empty, entirely invisible
// string — which then wins over a real aria-label fallback via ||,
// since an empty check never triggers. Stripping them first is what
// makes that fallback actually fire.
const INVISIBLE_CHARS = [
  0x200b, // zero-width space
  0x200c, // zero-width non-joiner
  0x200d, // zero-width joiner
  0x2060, // word joiner
  0xfeff  // zero-width no-break space / BOM
]
  .map(code =>
    String.fromCharCode(code)
  )
  .join("");

const INVISIBLE_CHAR_PATTERN =
  new RegExp(
    `[${INVISIBLE_CHARS}]`,
    "g"
  );

// A bare count badge ("154", "1.2k", "5") — confirmed live: LinkedIn
// renders its Like/Comment/Repost/Send action buttons with the
// reaction COUNT as their only visible text, while the button's own
// aria-label ("Repost") — what actually says what clicking it does
// — sits unused underneath it. Own text normally wins over
// aria-label since it's what a person actually reads, but a number
// alone tells the agent nothing about the action, so this is the one
// case where the aria-label is the more useful signal.
const BARE_COUNT_PATTERN =
  /^[\d,.]+[kKmM]?$/;

function agentElementText(
  el: HTMLElement
): string {

  // A form control's own text content is empty by definition (an
  // <input>/<textarea>/<select> has no text nodes of its own — its
  // question is almost always a separate <label>) — the fallback
  // chain below (own text, aria-label, placeholder, a nested SVG
  // title) never actually checks for one, so on a plain
  // <label>College</label><input> pair — an extremely common,
  // completely standard HTML pattern — this returned "" for the
  // input, indistinguishable from every OTHER unlabeled input on
  // the same form (e.g. Email right next to it). With nothing to
  // tell them apart, the model had nothing reliable to reason from
  // and picked the wrong one. getLabel() is the same comprehensive
  // label lookup already hardened for the Apply agent this session
  // (label[for], aria-labelledby, wrapping <label>, a non-generic
  // placeholder, nearby sibling text, a prettified `name` attribute)
  // — reusing it here means every one of those fixes also applies
  // to how the Browser Agent reads a form, not just the Apply flow.
  if (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement
  ) {

    const label =
      getLabel(el);

    if (label) {
      return label
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 140);
    }
  }

  const visibleOwnText =
    textOf(el)
      .replace(
        INVISIBLE_CHAR_PATTERN,
        ""
      )
      .trim();

  const ariaLabel =
    el.getAttribute("aria-label");

  const preferAriaLabel =
    !visibleOwnText ||
    (
      !!ariaLabel &&
      BARE_COUNT_PATTERN.test(
        visibleOwnText
      )
    );

  const text =
    (
      preferAriaLabel
        ? ariaLabel
        : visibleOwnText
    ) ||
    visibleOwnText ||
    ariaLabel ||
    (
      el instanceof HTMLInputElement ||
      el instanceof HTMLTextAreaElement
        ? el.placeholder
        : ""
    ) ||
    // Last resort for an icon-only control with literally no
    // accessible name of its own (confirmed live: LinkedIn's newer
    // search-results feed cards render Like/Comment/etc as bare,
    // unlabeled <div>s) — a descendant SVG icon or nested element
    // sometimes still carries a real label even when the clickable
    // wrapper itself doesn't.
    el.querySelector(
      "svg > title"
    )?.textContent ||
    el.querySelector(
      "[aria-label]"
    )?.getAttribute(
      "aria-label"
    ) ||
    "";

  return text
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
}

// How far up the tree to look, and how much text is "enough" to
// count as real surrounding content rather than another wrapper
// div — a post/card container's full text is usually well past this
// within a couple of levels, so this stays cheap even on a deep
// component tree.
const AGENT_CONTEXT_MAX_DEPTH = 8;
const AGENT_CONTEXT_MIN_LENGTH = 60;
// Enough to carry a feed post's opening lines — the part that says
// whether it's genuinely a hiring post, an opinion piece, a "just
// got hired" celebration, etc. — not just its first sentence. Raised
// from 260 once the per-step screenshot (a flat ~1k tokens) was
// dropped, so there's budget for it.
const AGENT_CONTEXT_MAX_LENGTH = 340;

// Compact, distinct links found inside the same container the
// context text came from — appended to `context` so an icon-only
// control (a 3-dot menu, a Like button) also carries the identifying
// links of the thing it belongs to. This is what lets the agent tell
// e.g. a post by a person (a nearby /in/… profile link) from one by
// an organization page (a /company/… link), or find a card's real
// destination, without having to correlate separate elements in a
// flat list. Same-origin links show as their path; off-site links
// show as host + path.
const AGENT_CONTEXT_MAX_LINKS = 6;
const AGENT_CONTEXT_LINKS_MAX_LENGTH = 160;

function nearbyLinkHints(node: Element): string {

  const seen = new Set<string>();

  for (const anchor of Array.from(
    node.querySelectorAll("a[href]")
  )) {

    let resolved: URL;
    try {
      resolved = new URL((anchor as HTMLAnchorElement).href);
    } catch {
      continue;
    }

    if (!/^https?:$/.test(resolved.protocol)) {
      continue;
    }

    const path =
      resolved.pathname.replace(/\/+$/, "");

    // A bare "/" or an anchor with no path carries no identifying
    // information — skip it.
    if (path.length <= 1 && !resolved.search) {
      continue;
    }

    const compact =
      resolved.host === window.location.host
        ? path || "/"
        : resolved.host + path;

    seen.add(compact);

    if (seen.size >= AGENT_CONTEXT_MAX_LINKS) {
      break;
    }
  }

  if (seen.size === 0) {
    return "";
  }

  return ` ⟨links: ${
    Array.from(seen)
      .join(", ")
      .slice(0, AGENT_CONTEXT_LINKS_MAX_LENGTH)
  }⟩`;
}

/**
 * The nearest ancestor's readable text — how the agent "reads" the
 * post/card/thread a control belongs to, since the control itself
 * (Like, Repost, a 3-dot menu) carries none of that content in its
 * own label. Walks up until an ancestor has enough text to actually
 * be the surrounding content rather than a bare layout wrapper, then
 * appends a compact list of the identifying links inside it.
 */
function agentElementContext(
  el: HTMLElement
): string {

  let node =
    el.parentElement;

  for (
    let depth = 0;
    depth < AGENT_CONTEXT_MAX_DEPTH &&
      node;
    depth++
  ) {

    const text =
      textOf(node)
        .replace(
          INVISIBLE_CHAR_PATTERN,
          ""
        )
        .replace(/\s+/g, " ")
        .trim();

    if (
      text.length >=
      AGENT_CONTEXT_MIN_LENGTH
    ) {
      return (
        text.slice(0, AGENT_CONTEXT_MAX_LENGTH) +
        nearbyLinkHints(node)
      );
    }

    node =
      node.parentElement;
  }

  return "";
}

// Some sites (confirmed live: LinkedIn's own "Copy link to post"
// toast) route an outbound link through a same-site redirect/safety
// wrapper instead of linking to the real destination directly — the
// actual target sits in a query parameter on the wrapper URL
// instead. Reporting the wrapper URL as "the link" would hand back
// an internal redirect endpoint instead of the thing the user
// actually asked for (e.g. "give me the URL of this post"), so this
// unwraps the common param names sites use for this before falling
// back to the href as-is.
const REDIRECT_URL_PARAM_NAMES = [
  "url",
  "u",
  "redirect",
  "redirect_uri",
  "destination",
  "target"
];

function resolveElementHref(
  el: HTMLAnchorElement
): string {

  try {

    const url = new URL(el.href);

    for (const param of REDIRECT_URL_PARAM_NAMES) {

      const value =
        url.searchParams.get(param);

      if (
        value &&
        /^https?:\/\//i.test(value)
      ) {
        return value;
      }
    }
  } catch {
    // Malformed/relative href — fall through to the raw value.
  }

  return el.href;
}

function agentElementValue(
  el: HTMLElement
): string {

  if (
    el instanceof HTMLInputElement
  ) {

    if (
      el.type === "checkbox" ||
      el.type === "radio"
    ) {
      return el.checked
        ? "checked"
        : "unchecked";
    }

    return el.value || "";
  }

  if (
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement
  ) {
    return el.value || "";
  }

  return "";
}

function captureAgentElements(): AgentElement[] {

  const elements =
    queryAllDeep(
      AGENT_ELEMENT_SELECTOR
    ).filter(isRendered);

  const viewportHeight =
    window.innerHeight || 0;

  const scored =
    elements.map((el, index) => {

      const rect =
        el.getBoundingClientRect();

      const inOrNearViewport =
        rect.bottom > -viewportHeight &&
        rect.top < viewportHeight * 2;

      return {
        el,
        index,
        inOrNearViewport
      };
    });

  const prioritized =
    scored
      .sort((a, b) => {

        if (
          a.inOrNearViewport !==
          b.inOrNearViewport
        ) {
          return a.inOrNearViewport
            ? -1
            : 1;
        }

        return a.index - b.index;
      })
      .slice(0, MAX_AGENT_ELEMENTS)
      // Restore original document order within the kept set — the
      // LLM reasons about the page more reliably reading it top to
      // bottom than in "viewport-priority" order.
      .sort((a, b) => a.index - b.index);

  return prioritized.map(({ el }, index) => {

    const text =
      agentElementText(el);

    const href =
      el instanceof HTMLAnchorElement
        ? resolveElementHref(el)
        : "";

    // Only elements with short/generic own text need surrounding
    // context to be identifiable — a real link/heading's own text
    // is already enough, and computing this for every element on
    // a long feed would mean walking the ancestor chain hundreds
    // of times for no benefit. BUT an icon-only control can still
    // have a long *accessible name* rather than short visible text
    // — e.g. LinkedIn now labels a post's ⋯ menu "Open control menu
    // for post by <Name>" (well over 40 chars). Without context that
    // button loses its `⟨links: …⟩` hints, which is exactly what
    // tells a person's post (/in/…) from an organization's
    // (/company/…). So also compute context for a hrefless
    // button/menu control whose "text" is really just an aria-label
    // (no visible text node of its own).
    const isLabelOnlyControl =
      !href &&
      !textOf(el).replace(INVISIBLE_CHAR_PATTERN, "").trim() &&
      text.length < 160;

    return {
      id: ensureId(el, index),
      role: agentElementRole(el),
      text,
      value: agentElementValue(el),

      context:
        text.length < 40 || isLabelOnlyControl
          ? agentElementContext(el)
          : "",

      href
    };
  });
}

function findAgentElement(
  id: string
): HTMLElement | null {

  return (
    queryAllDeep(
      `[data-jobai-id="${cssString(id)}"]`
    )[0] ||
    getElementByIdDeep(id) ||
    null
  );
}

// Parses a combo like "Enter", "Escape", "ctrl+a", "shift+Tab" and
// dispatches the matching keydown/keyup pair on `el` — the standard
// synthetic-KeyboardEvent approach. Not a browser-trusted event (a
// content script can't mint one), so the rare site that specifically
// gates on trustedness rather than just listening for the key won't
// respond — the same documented limitation as the other synthetic-
// event fallbacks in this file.
function dispatchKeyCombo(
  el: HTMLElement,
  combo: string
): void {

  const parts =
    combo
      .split("+")
      .map(part => part.trim());

  const keyPart =
    parts[parts.length - 1];

  const modifiers = new Set(
    parts
      .slice(0, -1)
      .map(part => part.toLowerCase())
  );

  const namedKeys: Record<string, string> = {
    enter: "Enter",
    esc: "Escape",
    escape: "Escape",
    tab: "Tab",
    space: " ",
    backspace: "Backspace",
    delete: "Delete",
    arrowup: "ArrowUp",
    arrowdown: "ArrowDown",
    arrowleft: "ArrowLeft",
    arrowright: "ArrowRight",
    up: "ArrowUp",
    down: "ArrowDown",
    left: "ArrowLeft",
    right: "ArrowRight",
    home: "Home",
    end: "End",
    pageup: "PageUp",
    pagedown: "PageDown"
  };

  const key =
    namedKeys[(keyPart ?? "").toLowerCase()] ||
    (keyPart ?? "");

  const eventInit: KeyboardEventInit = {
    key,
    bubbles: true,
    cancelable: true,
    ctrlKey: modifiers.has("ctrl"),
    altKey: modifiers.has("alt"),
    shiftKey: modifiers.has("shift"),
    metaKey:
      modifiers.has("meta") ||
      modifiers.has("cmd")
  };

  el.dispatchEvent(
    new KeyboardEvent(
      "keydown",
      eventInit
    )
  );

  el.dispatchEvent(
    new KeyboardEvent(
      "keyup",
      eventInit
    )
  );
}

// HTML5 drag-and-drop only fires for real user gestures in a
// trusted browser, never for a genuinely trusted synthetic drag —
// this is the same well-known "dispatch the sequence of drag events
// with a real DataTransfer" simulation used broadly for scripted
// DnD testing. Works for the common case (a reorderable list, a
// Kanban card) where the site's own dragover/drop handlers just
// read event.dataTransfer and don't require OS-level trustedness.
function simulateDragAndDrop(
  source: HTMLElement,
  target: HTMLElement
): void {

  const dataTransfer = new DataTransfer();

  const sourceRect =
    source.getBoundingClientRect();

  const targetRect =
    target.getBoundingClientRect();

  const dragEvent = (
    type: string,
    _el: HTMLElement,
    rect: DOMRect
  ) =>
    new DragEvent(type, {
      bubbles: true,
      cancelable: true,
      dataTransfer,
      clientX: rect.x + rect.width / 2,
      clientY: rect.y + rect.height / 2
    });

  source.dispatchEvent(
    dragEvent("dragstart", source, sourceRect)
  );

  target.dispatchEvent(
    dragEvent("dragenter", target, targetRect)
  );

  target.dispatchEvent(
    dragEvent("dragover", target, targetRect)
  );

  target.dispatchEvent(
    dragEvent("drop", target, targetRect)
  );

  source.dispatchEvent(
    dragEvent("dragend", source, targetRect)
  );
}

// A "Link copied to clipboard" / "View post" style toast (LinkedIn
// fires one after "Copy link to post") STACKS: copy a second post's
// link while the first toast is still up and you get two identical
// toasts — and the newer copy often doesn't even land, so the agent
// reads a stale toast and pins an earlier post's URL onto a later
// one. That is the main reason "get the URL of 10 posts" works for
// the first and then goes wrong. Clearing leftover toasts right
// before the NEXT action keeps it to one fresh toast per copy; the
// toast the agent still needs to read survives this step (its URL is
// already captured in the snapshot that prompted this action) and is
// only cleared on the following one. `keepEl` guards the rare case
// where the action itself targets something inside a toast.
function clearStaleNotificationToasts(
  keepEl: HTMLElement | null
): void {

  const toasts = queryAllDeep(
    ".artdeco-toast-item, [role='alert']"
  );

  for (const toast of toasts) {

    if (keepEl && toast.contains(keepEl)) {
      continue;
    }

    const dismiss =
      toast.querySelector<HTMLElement>(
        "button[aria-label='Dismiss'], " +
          "button[aria-label*='dismiss'], " +
          ".artdeco-toast-item__dismiss"
      );

    if (dismiss) {
      dismiss.click();
    } else {
      toast.remove();
    }
  }
}

// Right after a "Copy link to post" click, get the permalink that was
// just copied — first from the clipboard (the authoritative copy),
// then, if that's not readable (no permission / not focused), from
// the link inside the freshly-shown "Link copied" toast, unwrapped
// the same way any other link in a snapshot is. Polls briefly because
// the toast/clipboard write lands a beat after the click. Returns ""
// if nothing turns up — the caller just falls back to the toast being
// in the next snapshot as before.
async function readJustCopiedLink(): Promise<string> {

  for (let attempt = 0; attempt < 8; attempt++) {

    await new Promise(resolve => setTimeout(resolve, 150));

    try {
      const clip =
        (await navigator.clipboard.readText()).trim();

      if (/^https?:\/\//i.test(clip)) {
        return clip;
      }
    } catch {
      // No clipboard read access here — fall through to the toast.
    }

    for (const toast of queryAllDeep(
      ".artdeco-toast-item, [role='alert']"
    )) {

      const link =
        toast.querySelector<HTMLAnchorElement>("a[href]");

      if (link) {
        return resolveElementHref(link);
      }
    }
  }

  return "";
}

async function executeAgentAction(
  action: string,
  targetId: string | undefined,
  text: string | undefined,
  dropTargetId?: string,
  fileBuffer?: ArrayBuffer,
  fileName?: string,
  fileType?: string
): Promise<{ ok: boolean; error?: string; note?: string }> {

  if (action === "wait") {
    return { ok: true };
  }

  clearStaleNotificationToasts(
    targetId ? findAgentElement(targetId) : null
  );

  if (action === "key") {

    const target =
      (targetId && findAgentElement(targetId)) ||
      (document.activeElement as HTMLElement | null) ||
      document.body;

    if (targetId && !findAgentElement(targetId)) {
      return {
        ok: false,
        error:
          "Target element not found — the page may have changed since the last snapshot."
      };
    }

    if (targetId) {
      target.focus?.();
    }

    dispatchKeyCombo(
      target,
      text || ""
    );

    return { ok: true };
  }

  if (action === "drag") {

    if (!dropTargetId) {
      return {
        ok: false,
        error: "No drop_target_id given."
      };
    }

    const source =
      targetId ? findAgentElement(targetId) : null;

    const target =
      findAgentElement(dropTargetId);

    if (!source || !target) {
      return {
        ok: false,
        error:
          "Drag source or drop target not found — the page may have changed since the last snapshot."
      };
    }

    // Both elements need real, current layout rects for the
    // simulated event coordinates to mean anything — an off-screen
    // element (never scrolled to) would otherwise hand the drag
    // events a stale/zeroed rect.
    source.scrollIntoView({
      block: "center",
      inline: "nearest",
      behavior: "auto"
    });

    await new Promise(resolve => setTimeout(resolve, 200));

    simulateDragAndDrop(source, target);

    return { ok: true };
  }

  if (action === "upload_file") {

    if (!targetId) {
      return {
        ok: false,
        error: "No target_id given."
      };
    }

    if (!fileBuffer || !fileName) {
      return {
        ok: false,
        error:
          "No file was attached to this message — attach one before asking me to upload it."
      };
    }

    const el = findAgentElement(targetId);

    if (
      !el ||
      !(el instanceof HTMLInputElement) ||
      el.type !== "file"
    ) {
      return {
        ok: false,
        error:
          "Target element isn't a file input, or wasn't found."
      };
    }

    assignFileToInput(
      el,
      fileBuffer,
      fileName,
      fileType || "application/octet-stream"
    );

    return { ok: true };
  }

  // Scrolls the page (not a specific element) roughly one viewport —
  // used to reveal more of a feed/list when whatever's needed isn't
  // in the current snapshot at all yet, as opposed to "scroll_to"
  // which brings an already-known element into view. Direction
  // matters: this used to ONLY ever scroll down, so if the page's
  // scroll position had already moved past something (a name field
  // above the fold, the top of a long form the agent had previously
  // scrolled down from), there was no way back up to it at all —
  // confirmed live as the reason "fill name" reported the name field
  // "not visible" and gave up, when it was simply above the current
  // scroll position the whole time.
  if (action === "scroll_page") {

    const direction =
      (text || "down").toLowerCase() ===
      "up"
        ? -1
        : 1;

    const scrollable =
      document.scrollingElement ||
      document.documentElement;

    window.scrollBy({
      top:
        direction *
        (window.innerHeight || 800) *
        0.85,
      left: 0,
      behavior: "auto"
    });

    // Some sites scroll an inner container instead of the window
    // (a feed embedded in a fixed-height panel) — nudge the tallest
    // scrollable ancestor of the current viewport center too, as a
    // best-effort fallback alongside the window scroll above.
    if (
      scrollable &&
      scrollable.scrollHeight >
        scrollable.clientHeight
    ) {
      scrollable.scrollTop +=
        direction *
        (window.innerHeight || 800) *
        0.85;
    }

    return { ok: true };
  }

  if (!targetId) {
    return {
      ok: false,
      error: "No target_id given."
    };
  }

  const el =
    findAgentElement(targetId);

  if (!el) {
    return {
      ok: false,
      error:
        "Target element not found — the page may have changed since the last snapshot."
    };
  }

  if (action === "scroll_to") {
    el.scrollIntoView({
      block: "center",
      inline: "nearest",
      behavior: "auto"
    });
    return { ok: true };
  }

  if (action === "click") {

    const clickedText =
      agentElementText(el).toLowerCase();

    // A "Copy link to post" / "Copy link" control puts the permalink
    // the agent is after into a short-lived "Link copied" toast (and
    // the clipboard). The agent kept trying to CLICK that toast's
    // "View post" link to "read" the URL — which navigates off the
    // results page. Surface the copied URL straight into the action
    // result instead, so it lands in history and there's nothing to
    // click through.
    const isCopyLink =
      /\bcopy link\b/.test(clickedText) &&
      !/copy link address/.test(clickedText);

    simulateClick(el);

    if (isCopyLink) {
      const copied =
        await readJustCopiedLink();

      if (copied) {
        return {
          ok: true,
          note: `Copied link: ${copied}`
        };
      }
    }

    return { ok: true };
  }

  // Hovers the element without clicking — some UI only reveals
  // itself this way rather than on click (LinkedIn's reaction
  // picker: Celebrate/Support/Love/Insightful/Funny only appear
  // after hovering its Like control, never from a click alone). A
  // real click right after a hover would just trigger the DEFAULT
  // reaction, so this exists specifically so the agent can reach
  // options a click-only vocabulary can't.
  if (action === "hover") {

    el.scrollIntoView({
      block: "center",
      inline: "nearest",
      behavior: "auto"
    });

    const rect =
      el.getBoundingClientRect();

    const point = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX:
        rect.x + rect.width / 2,
      clientY:
        rect.y + rect.height / 2
    };

    el.dispatchEvent(
      new PointerEvent(
        "pointerover",
        point
      )
    );

    el.dispatchEvent(
      new MouseEvent(
        "mouseover",
        point
      )
    );

    el.dispatchEvent(
      new MouseEvent(
        "mouseenter",
        point
      )
    );

    return { ok: true };
  }

  if (action === "type") {

    if (
      el instanceof HTMLInputElement ||
      el instanceof HTMLTextAreaElement
    ) {
      await typeCharacters(
        el,
        text || ""
      );
      return { ok: true };
    }

    if (
      el.getAttribute(
        "contenteditable"
      ) === "true"
    ) {

      el.focus();

      el.textContent =
        text || "";

      el.dispatchEvent(
        new InputEvent(
          "input",
          {
            bubbles: true,
            inputType: "insertText",
            data: text || ""
          }
        )
      );

      return { ok: true };
    }

    return {
      ok: false,
      error:
        "Target element isn't a text-editable field."
    };
  }

  return {
    ok: false,
    error: `Unknown action "${action}".`
  };
}

/**
 * After a final Submit: does the page say the application went
 * through, or show a captcha? Read by the AI apply flow
 * (src/shared/ai-apply/flow.ts) to decide "applied" vs "not
 * confirmed".
 */
const CONFIRMATION_PATTERN =
  /thank(s| you) for (applying|your application|your interest)|application (has been |was )?(submitted|received|sent|complete)|successfully (applied|submitted)|we('ve| have) received your application|you('ve| have) (successfully )?applied/i;
const CAPTCHA_PATTERN =
  /verify (that )?you are (a )?human|are you a robot/i;

/**
 * A job page whose apply button now reads "Applied" (iimjobs' disabled "Applied" button, Naukri's
 * #already-applied). Buttons only: a nav link "Applied" (Wellfound's applied-jobs list) is not one.
 */
function appliedButtonShown(): boolean {
  return [...document.querySelectorAll<HTMLElement>("button, #already-applied")]
    .some(b => isRendered(b) && /^(applied|application sent!?)$/i.test((b.innerText || "").trim()));
}

/** A job page saying the job is no longer open. */
const EXPIRED_PATTERN =
  /no longer (accepting|available|active)|(job|posting|position) (has )?expired|(this|the) (job|position|posting|opening) (is|has been) (closed|expired|filled|removed)|position (has been )?filled|applications? (are|is) (now )?closed|job not found/i;

function pageSignals(): {
  confirmed: boolean;
  captcha: boolean;
  closed: boolean;
  text: string;
} {
  const text = (document.body?.innerText || "").slice(0, 4000);
  const captchaFrame = [
    ...document.querySelectorAll<HTMLElement>(
      "iframe[src*='recaptcha/api2/bframe'], iframe[src*='hcaptcha'], iframe[src*='challenges.cloudflare']"
    )
    // A challenge frame is loaded on many careers pages but stays visibility:hidden until Google actually challenges
    // (Allstate, 2026-11-05: reported as "a captcha is showing" on a page with no challenge).
  ].some(f => isRendered(f) && getComputedStyle(f).visibility !== "hidden" && f.getBoundingClientRect().height > 0);
  return {
    confirmed: CONFIRMATION_PATTERN.test(text) || (!naukriChatRoot() && naukriApplied()) || appliedButtonShown(),
    captcha: captchaFrame || CAPTCHA_PATTERN.test(text),
    closed: EXPIRED_PATTERN.test(text),
    text: text.slice(0, 600)
  };
}

/**
 * Message handling. The service worker injects this file into every
 * frame of an agent tab, possibly more than once (a retry after a
 * navigation): only the first copy in a frame answers.
 */
/** Real input from you on this page (isTrusted events only), counted for the wait before the final Submit. */
const userActivity = { count: 0, at: 0 };
for (const type of ["input", "change", "keydown", "mousedown", "paste"]) {
  document.addEventListener(type, e => {
    if (!e.isTrusted) return;
    userActivity.count += 1;
    userActivity.at = Date.now();
  }, true);
}

/**
 * Your own answers on this form, saved to form memory as yours (user, 2026-11-06: "in case I'm writing anything in
 * a form then always save it"): a box you typed in (sent when you leave it), a dropdown, radio or checkbox you
 * picked, a custom dropdown's option you clicked. Only real input (isTrusted), never the agent's own fills. Never
 * a password, code, card, bank or ID number.
 */
const SENSITIVE_LABEL =
  /password|passcode|\botp\b|one[- ]time|verification code|security code|captcha|card number|credit card|debit card|cvv|cvc|expir|ssn|social security|aadhaa?r|\bpan\b|passport (no|number)|bank|account (no|number)|iban|routing|ifsc|sort code|swift/i;
const PLACEHOLDER_ANSWER = /^(select|select one|select an option|choose|choose one|please select|--+|none selected)\.?$/i;
const sentAnswers = new Map<string, string>();
const typedIn = new WeakSet<Element>();

function reportYourAnswer(label: string, answer: string): void {
  const l = label.replace(/\s+/g, " ").replace(/[*✱:]+\s*$/, "").trim();
  const a = answer.replace(/\s+$/, "").trim();
  if (!l || !a || l.length > 300 || SENSITIVE_LABEL.test(l) || PLACEHOLDER_ANSWER.test(a)) return;
  if (sentAnswers.get(l) === a) return;
  sentAnswers.set(l, a);
  try {
    chrome.runtime.sendMessage({ type: "user-answer", label: l, answer: a.slice(0, 2000), host: location.hostname })?.catch?.(() => undefined);
  } catch {
    // the extension was reloaded: nothing to tell
  }
}

function yourAnswerOf(el: Element): { label: string; answer: string } | null {
  if (el instanceof HTMLInputElement) {
    if (["password", "file", "hidden", "submit", "button", "image", "reset"].includes(el.type)) return null;
    if (el.type === "radio") {
      if (!el.checked) return null;
      return { label: getGroupLabel(el) || getLabel(el), answer: getInputLabel(el) || el.value };
    }
    if (el.type === "checkbox") {
      const group = getCheckboxGroupElements(el);
      if (group.length > 1) {
        const picked = group.filter(c => c.checked).map(c => getInputLabel(c) || c.value).filter(Boolean);
        return { label: getGroupLabel(el) || getLabel(el), answer: picked.join(", ") };
      }
      return { label: getInputLabel(el) || getGroupLabel(el), answer: el.checked ? "Yes" : "No" };
    }
    return { label: getLabel(el), answer: el.value };
  }
  if (el instanceof HTMLTextAreaElement) return { label: getLabel(el), answer: el.value };
  if (el instanceof HTMLSelectElement) return { label: getLabel(el), answer: [...el.selectedOptions].map(o => o.text.trim()).join(", ") };
  if (el instanceof HTMLElement && (el.getAttribute("role") === "combobox" || el.isContentEditable)) {
    return { label: getLabel(el), answer: (el as HTMLInputElement).value || textOf(el) };
  }
  return null;
}

function fieldOf(target: EventTarget | null): Element | null {
  if (!(target instanceof Element)) return null;
  return target.closest("input, textarea, select, [role='combobox'], [contenteditable='true']");
}

document.addEventListener("input", e => {
  const el = fieldOf(e.target);
  if (e.isTrusted && el) typedIn.add(el);
}, true);
document.addEventListener("change", e => {
  if (!e.isTrusted) return;
  const el = fieldOf(e.target);
  // Typed boxes are sent when you leave them (focusout); choices right away.
  if (!el || el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && !["radio", "checkbox"].includes(el.type))) return;
  const a = yourAnswerOf(el);
  if (a) reportYourAnswer(a.label, a.answer);
}, true);
document.addEventListener("focusout", e => {
  if (!e.isTrusted) return;
  const el = fieldOf(e.target);
  if (!el || !typedIn.has(el)) return;
  typedIn.delete(el);
  const a = yourAnswerOf(el);
  if (a) reportYourAnswer(a.label, a.answer);
}, true);
// A custom dropdown (Workday, React Select, Greenhouse): you click an option in its list; read the field it fills.
document.addEventListener("click", e => {
  if (!e.isTrusted || !(e.target instanceof Element)) return;
  const option = e.target.closest("[role='option'], [role='menuitem'], [data-automation-id='promptOption']");
  if (!option) return;
  const list = option.closest("[role='listbox'], [role='menu']");
  setTimeout(() => {
    const owner = (list?.id && document.querySelector(`[aria-controls="${cssString(list.id)}"], [aria-owns="${cssString(list.id)}"]`))
      || (document.activeElement instanceof HTMLElement && document.activeElement.closest("[role='combobox'], [aria-haspopup='listbox'], button[aria-haspopup]"));
    if (!(owner instanceof HTMLElement)) return;
    const label = getLabel(owner) || getGroupLabel(owner);
    const answer = (owner as HTMLInputElement).value || textOf(owner) || textOf(option);
    if (label) reportYourAnswer(label, answer);
  }, 400);
}, true);

/**
 * A cover letter text option that is closed: a button/link "Write a cover letter" / "Add cover letter" / "Type a cover
 * letter", or a radio "Write cover letter" next to "Upload" and "None" (Indeed). Opens it when no cover letter text box
 * is on the page yet. Returns whether it pressed something.
 */
function openCoverLetterOption(): boolean {
  const root = getStepRoot();
  const boxOpen = queryAllDeep("textarea, [contenteditable='true']", root).some(el => isRendered(el as HTMLElement) && /cover ?letter/i.test(getLabel(el as HTMLElement) || ""));
  if (boxOpen) return false;
  const words = /^(\+\s*)?(write|add|type|compose|enter)( a| your)? cover ?letter$/i;
  const control = (queryAllDeep("button, a, [role='button'], label, [role='radio'], input[type='radio']", root) as HTMLElement[])
    .find(el => isRendered(el) && words.test(((el instanceof HTMLInputElement ? getInputLabel(el) : textOf(el)) || "").replace(/\s+/g, " ").trim()));
  if (!control) return false;
  if (control instanceof HTMLInputElement) {
    if (control.checked) return false;
    simulateClick(control);
  } else {
    simulateClick(control);
  }
  return true;
}

function firstEngineInFrame(): boolean {
  const w = window as unknown as { __aiFormEngine?: boolean };
  if (w.__aiFormEngine) return false;
  w.__aiFormEngine = true;
  return true;
}

if (firstEngineInFrame()) chrome.runtime.onMessage.addListener(
  (
    message,
    _sender,
    sendResponse
  ) => {

    // Indeed Apply's own applier (src/content/ats/indeed.ts): IN_* messages.
    if (typeof message?.type === "string" && message.type.startsWith("IN_")) {
      return handleIndeedMessage(message, sendResponse);
    }

    // Keka's own applier (src/content/ats/keka.ts): KK_* messages.
    if (typeof message?.type === "string" && message.type.startsWith("KK_")) {
      return handleKekaMessage(message, sendResponse);
    }

    // Zoho Recruit's own applier (src/content/ats/zoho.ts): ZH_* messages.
    if (typeof message?.type === "string" && message.type.startsWith("ZH_")) {
      return handleZohoMessage(message, sendResponse);
    }

    // Workday's own applier (src/content/ats/workday.ts): WD_* messages.
    if (typeof message?.type === "string" && message.type.startsWith("WD_")) {
      return handleWorkdayMessage(message, sendResponse);
    }

    if (message?.type === "PAGE_SIGNALS") {
      sendResponse({ ok: true, ...pageSignals() });
      return true;
    }

    // The account agent (src/content/account.ts): sign in or create the account with your .env email/password.
    // After a real mouse click on the account button (the scripted press did nothing): what happened.
    if (message?.type === "ACCOUNT_AFTER") {
      watchAfterPress(15000)
        .then(r => sendResponse(r))
        .catch(e => sendResponse({ ok: false, page: "none", outcome: "stopped", reason: String(e).slice(0, 200) }));
      return true;
    }

    if (message?.type === "ACCOUNT_STEP") {
      accountStep(String(message.email ?? ""), String(message.password ?? ""))
        .then(r => sendResponse(r))
        .catch(e => sendResponse({ ok: false, page: "none", outcome: "stopped", reason: String(e).slice(0, 200) }));
      return true;
    }

    // Indeed-style "Write a cover letter" / "Add cover letter": open the text box when none is shown yet.
    if (message?.type === "OPEN_COVER_LETTER") {
      sendResponse({ ok: true, opened: openCoverLetterOption() });
      return true;
    }

    // Your own changes on the page (real keys, clicks, edits; never the agent's scripted ones), for the wait before
    // the final Submit: the flow restarts its 30 s each time this count changes.
    if (message?.type === "USER_ACTIVITY") {
      sendResponse({ ok: true, count: userActivity.count, at: userActivity.at });
      return true;
    }

    // The page's whole text, for the pre-submit review (src/shared/ai-apply/pre-submit.ts): a Review page lists
    // every section of the application.
    if (message?.type === "PAGE_TEXT") {
      sendResponse({ ok: true, title: document.title, text: (document.body?.innerText || "").slice(0, 30000) });
      return true;
    }

    // The final Submit. Only the AI apply flow sends this, and only in
    // live mode with "Submit at the final step" turned on.
    if (message?.type === "CLICK_SUBMIT") {
      const button = findSubmitButton();
      if (!button) {
        sendResponse({ ok: false, error: "No Submit button found." });
        return true;
      }
      simulateClick(button);
      sendResponse({ ok: true });
      return true;
    }

    if (
      message?.type ===
      "EXTRACT_FORM"
    ) {

      extractForm()
        .then(data => {

          sendResponse({
            ok: true,
            data
          });

        })
        .catch(error => {

          sendResponse({
            ok: false,
            error:
              error instanceof Error
                ? error.message
                : "Could not read application page."
          });

        });

      return true;
    }

    if (
      message?.type ===
      "FILL_FIELDS"
    ) {

      const answers =
        Array.isArray(
          message.answers
        )
          ? message.answers
          : [];

      // Fill sequentially rather than
      // concurrently: filling a
      // combobox/select can trigger a
      // framework re-render (observed
      // on BambooHR — selecting State
      // regenerates other fields'
      // auto-generated ids), which can
      // race with an in-flight fill of
      // a different field targeting the
      // DOM node React is about to
      // replace. Awaiting each one lets
      // that settle before the next
      // field is located.
      (async () => {

        const results = [];

        for (
          const answer of
            answers as {
              field_id: string;
              answer: string;
              label?: string;
            }[]
        ) {

          results.push({
            field_id:
              answer.field_id,

            filled:
              await fillField(
                answer.field_id,
                answer.answer,
                answer.label
              )
          });
        }

        return results;
      })()
        .then(results => {

          sendResponse({
            ok: true,
            results
          });

        })
        .catch(error => {

          sendResponse({
            ok: false,
            error:
              error instanceof Error
                ? error.message
                : "Could not fill fields"
          });

        });

      return true;
    }

    if (
      message?.type ===
      "FILL_RESUME"
    ) {

      // Messages from the service worker are JSON, so the file comes
      // as base64 (an ArrayBuffer would arrive as {}).
      fillResume(
        message.field_id,
        typeof message.base64 === "string"
          ? Uint8Array.from(atob(message.base64), c => c.charCodeAt(0)).buffer
          : message.buffer,
        message.file_name,
        message.file_type,
        message.label
      )
        .then(filled => {

          sendResponse({
            ok: true,
            filled
          });

        })
        .catch(error => {

          sendResponse({
            ok: false,
            error:
              error instanceof Error
                ? error.message
                : "Resume upload failed"
          });

        });

      return true;
    }

    if (
      message?.type ===
      "FIND_CONTINUE"
    ) {

      const button =
        findContinueButton();

      sendResponse({
        ok: true,
        found:
          !!button,
        text:
          button?.innerText ||
          button?.getAttribute(
            "value"
          ) ||
          ""
      });

      return true;
    }

    if (
      message?.type ===
      "FIND_SUBMIT"
    ) {

      const button =
        findSubmitButton();

      sendResponse({
        ok: true,
        found:
          !!button,
        text:
          button?.innerText ||
          button?.getAttribute(
            "value"
          ) ||
          ""
      });

      return true;
    }

    if (
      message?.type ===
      "CLICK_CONTINUE"
    ) {

      const button =
        findContinueButton();

      if (!button) {

        sendResponse({
          ok: false,
          error:
            "No Continue button found."
        });

        return true;
      }

      simulateClick(button);

      sendResponse({
        ok: true
      });

      return true;
    }

    if (
      message?.type ===
      "FIND_APPLY"
    ) {

      const button =
        findApplyButton();

      sendResponse({
        ok: true,
        found: !!button,
        text:
          button?.innerText ||
          button?.getAttribute(
            "value"
          ) ||
          ""
      });

      return true;
    }

    // The page's clickables for the AI to choose the Apply control from (src/shared/ai-apply/apply-button.ts).
    if (message?.type === "APPLY_CANDIDATES") {
      sendResponse({ ok: true, candidates: listApplyChoices() });
      return true;
    }

    if (
      message?.type ===
      "CLICK_APPLY"
    ) {

      // `index`: the AI's pick from the last APPLY_CANDIDATES list.
      const button =
        typeof message.index === "number"
          ? (aiApplyChoices[message.index]?.isConnected ? aiApplyChoices[message.index]! : null)
          : findApplyButton();

      if (!button) {

        sendResponse({
          ok: false,
          error:
            "No Apply button found."
        });

        return true;
      }

      // A link that opens in a new tab (Target's "Apply" -> Workday, target=_blank; 2026-11-06): a scripted click
      // has no user gesture, so Chrome's popup blocker drops the new tab and nothing happens. Open its address in
      // this tab instead; the flow reads the tab again after every press.
      const popupHref = newTabLinkHref(button);
      if (popupHref) {
        sendResponse({ ok: true, navigated: popupHref });
        setTimeout(() => { location.href = popupHref; }, 50);
        return true;
      }

      simulateClick(button);

      sendResponse({
        ok: true
      });

      return true;
    }

    if (
      message?.type ===
      "FIND_ACCOUNT_CREATE"
    ) {

      const button =
        findAccountCreateButton();

      sendResponse({
        ok: true,
        found: !!button,
        text:
          button?.innerText ||
          button?.getAttribute(
            "value"
          ) ||
          ""
      });

      return true;
    }

    if (
      message?.type ===
      "CLICK_ACCOUNT_CREATE"
    ) {

      const button =
        findAccountCreateButton();

      if (!button) {

        sendResponse({
          ok: false,
          error:
            "No account-creation button found."
        });

        return true;
      }

      simulateClick(button);

      sendResponse({
        ok: true
      });

      return true;
    }

    if (
      message?.type ===
      "HAS_PASSWORD_FIELDS"
    ) {

      const fields =
        findPasswordFields();

      sendResponse({
        ok: true,
        count: fields.length,
        fieldIds:
          fields.map(
            (el, index) =>
              ensureId(el, index)
          )
      });

      return true;
    }

    if (
      message?.type ===
      "IS_VERIFICATION_GATE"
    ) {

      sendResponse({
        ok: true,
        isGate:
          looksLikeVerificationGate()
      });

      return true;
    }

    if (
      message?.type ===
      "DETECT_ERRORS"
    ) {

      const found = detectPageErrors();
      sendResponse({
        ok: true,
        errors: found.errors,
        page: found.page
      });

      return true;
    }

    if (
      message?.type ===
      "DIAGNOSTIC_SNAPSHOT"
    ) {

      sendResponse({
        ok: true,
        snapshot:
          captureDiagnosticSnapshot()
      });

      return true;
    }

    if (
      message?.type ===
      "PREPARE_REPEATABLE_SECTIONS"
    ) {

      (async () => {

        const root =
          getStepRoot();

        const experienceAdded =
          await prepareRepeatableSection(
            "experience",
            EXPERIENCE_SECTION_PATTERN,
            Number(
              message.experienceCount
            ) || 0
          );

        const educationAdded =
          await prepareRepeatableSection(
            "education",
            EDUCATION_SECTION_PATTERN,
            Number(
              message.educationCount
            ) || 0
          );

        // Whatever else the site has (Certifications, Languages,
        // Publications, Awards, Volunteer Experience...) — ensures
        // none of them are left empty even without dedicated
        // per-type profile data to size them from.
        const genericAdded =
          await prepareGenericRepeatableSections(
            root,
            [
              EXPERIENCE_SECTION_PATTERN,
              EDUCATION_SECTION_PATTERN
            ]
          );

        return (
          experienceAdded +
          educationAdded +
          genericAdded
        );
      })()
        .then(added => {

          sendResponse({
            ok: true,
            added
          });

        })
        .catch(error => {

          sendResponse({
            ok: false,
            error:
              error instanceof Error
                ? error.message
                : "Could not prepare repeatable sections."
          });

        });

      return true;
    }

    if (
      message?.type ===
      "FORCE_INTERACT_FIELD"
    ) {

      const el =
        findElement(
          message.field_id,
          message.label
        );

      if (!el) {

        sendResponse({
          ok: false,
          error:
            "Field not found."
        });

        return true;
      }

      forceInteractiveFill(
        el,
        message.value
      )
        .then(filled => {

          sendResponse({
            ok: true,
            filled
          });

        })
        .catch(error => {

          sendResponse({
            ok: false,
            error:
              error instanceof Error
                ? error.message
                : "Could not force-fill field."
          });

        });

      return true;
    }

    if (
      message?.type ===
      "AGENT_SNAPSHOT"
    ) {

      sendResponse({
        ok: true,
        snapshot: {
          url: location.href,
          title: document.title,
          elements: captureAgentElements()
        }
      });

      return true;
    }

    if (
      message?.type ===
      "AGENT_ACTION"
    ) {

      executeAgentAction(
        message.action,
        message.target_id,
        message.text,
        message.drop_target_id,
        message.buffer,
        message.file_name,
        message.file_type
      )
        .then(result => {

          sendResponse(result);

        })
        .catch(error => {

          sendResponse({
            ok: false,
            error:
              error instanceof Error
                ? error.message
                : "Could not execute action."
          });

        });

      return true;
    }

    return false;
  }
);
