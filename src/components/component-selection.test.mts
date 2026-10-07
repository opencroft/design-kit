// The rule: a page asked for a component that does not exist says so, and
// leaves the address alone.
//
// Both halves are asserted, and so is their composition, because each half can
// pass on its own while the pair is broken. A resolver that reports `missing`
// correctly is still wrong if the address writer collapses `missing` into the
// empty string; an address writer that returns null for `missing` is still
// wrong if the resolver never produces `missing` in the first place. The
// sentence worth quoting — a requested component never yields another
// component's address — is only true of the two together, so it gets a test of
// its own rather than being inferred from the parts.
//
// The dividing line under test is "was something asked for", not "did it
// parse". A one-part `?component=button` is a failed request even when a
// component of that name exists, and that case gets its own test because it is
// the one a lenient resolver would quietly get wrong while every other test
// here still passed.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { addressedComponent, type ComponentSelection, selectComponent, selectForAddress } from './component-selection.ts'
import { componentRouteOf } from './component-routes.ts'

const project = ['alert', 'button', 'card']

/** What this page's project answers to — its namespace slug and its storage
 *  id, because the reference grammar accepts either as a first half. Two
 *  values rather than one, so a test passing only because a single identity
 *  happened to match cannot hide here. */
const identities = ['kit', 'dp_kit']

/** A request against this page's project. */
const select = (requested: string | null, names: readonly string[] = project) => selectComponent(requested, names, identities)

/** The address for a request against `project`, in one step — the composition
 *  a caller actually performs. */
const addressFor = (requested: string | null) => addressedComponent(select(requested))

test('an address carrying no reference lands on the first component', () => {
  assert.deepEqual(select(null), { status: 'selected', name: 'alert' })
})

test('an address carrying an empty reference asks for nothing, rather than asking for something absent', () => {
  // `?component=` names no component, so there is nothing to report as not
  // found. This is the one value that is a parameter and still not a request.
  assert.deepEqual(select(''), { status: 'selected', name: 'alert' })
})

test('no reference and nothing to show selects nothing', () => {
  assert.deepEqual(select(null, []), { status: 'none' })
})

test('a reference that resolves is honoured rather than replaced by the first', () => {
  // Deliberately not the first name: a resolver that ignored the request and
  // returned names[0] would satisfy an assertion written against 'alert'.
  assert.deepEqual(select('kit.card'), { status: 'selected', name: 'card' })
})

test('both separators resolve, because the grammar reads both', () => {
  assert.deepEqual(select('kit/card'), { status: 'selected', name: 'card' })
})

test('a project answers to its storage id as well as its namespace', () => {
  // The grammar accepts either as a first half, so a page addressed by id has
  // to resolve exactly as one addressed by slug. Asserting only the slug would
  // pass against a resolver that compared against one identity and dropped the
  // rest.
  assert.deepEqual(select('dp_kit.card'), { status: 'selected', name: 'card' })
})

test('a reference naming a component the project does not hold is missing, and carries the reference as given', () => {
  // `kit.buton`, not `buton`: the address bar still shows the whole reference,
  // and a message quoting a different string reads as being about a different
  // request.
  assert.deepEqual(select('kit.buton'), { status: 'missing', requested: 'kit.buton' })
})

test('a reference for another project does not resolve, even to a component of that name here', () => {
  // The case that matters. `button` IS in this project, so every check that
  // only asks whether the name is present says yes — and the page then shows a
  // component the address did not ask for and rewrites the address to agree.
  // Nothing about the name is wrong; the half nobody compared is.
  assert.deepEqual(select('other.button'), { status: 'other-project', requested: 'other.button', project: 'other' })
  assert.deepEqual(select('dp_other/button'), { status: 'other-project', requested: 'dp_other/button', project: 'dp_other' })
})

test('the other-project answer carries the project that was asked for, not the whole reference', () => {
  // The sentence names the project half alone, so that half has to survive the
  // resolution. Quoting the whole reference would put a component name inside
  // a sentence about projects; quoting nothing would leave the reader to work
  // out which half was wrong.
  const selection = select('other.button')
  assert.equal(selection.status === 'other-project' && selection.project, 'other')
})

test('a name this project does not hold is still missing, not another project', () => {
  // The two failures are not interchangeable: one is a claim the page can
  // support and the other is not. A reference with the right project half and
  // an unknown name has been resolved TO this project, and the component
  // really is not here.
  assert.deepEqual(select('kit.ghost'), { status: 'missing', requested: 'kit.ghost' })
})

test('a page that does not yet know what it is resolves nothing', () => {
  // Not the same as knowing the address is wrong, and it does not need to be:
  // a page that cannot say whether an address is for it must not act as if it
  // is, and in that state it has nothing to show and no address to write.
  assert.deepEqual(selectComponent('kit.button', project, []), { status: 'missing', requested: 'kit.button' })
})

test('a one-part reference is a failed request even when a component of that name exists', () => {
  // `button` IS in the project, so a resolver lenient enough to read a bare
  // name as a reference would return it — inventing a one-part spelling
  // nothing else in this codebase reads, on the surface whose job is to refuse
  // what it cannot resolve.
  assert.deepEqual(select('button'), { status: 'missing', requested: 'button' })
})

test('a project holding nothing does not turn a failed request into a request nobody made', () => {
  // "There is nothing here" and "what you asked for is not here" are different
  // sentences, and only the second is true of this call.
  assert.deepEqual(select('kit.ghost', []), { status: 'missing', requested: 'kit.ghost' })
})

test('the address names the component that is shown', () => {
  assert.equal(addressedComponent({ status: 'selected', name: 'card' }), 'card')
})

test('the address drops its reference when nothing was asked for', () => {
  assert.equal(addressedComponent({ status: 'none' }), '')
})

test('a failed request leaves the address alone rather than clearing it', () => {
  // null and '' are both falsy and mean opposite things here: '' tells the
  // caller to delete the reference, null tells it not to write at all. A
  // resolver returning '' would erase what the person typed, which is the
  // quieter half of the same defect.
  assert.equal(addressedComponent({ status: 'missing', requested: 'kit.ghost' }), null)
})

test('a request that does not resolve never produces an address naming a different component', () => {
  // Every way a reference can fail, against a project that does hold
  // components — which is the only situation in which there is a wrong answer
  // available to give.
  // `other.button` and `dp_other.card` are the ones that matter most here:
  // both name a component this project really does hold, so a resolver that
  // compares only the name resolves them and the address is rewritten to a
  // different component than the one asked for. That rewrite is the harm.
  for (const requested of ['kit.ghost', 'button', 'Button', 'kit.Card', 'kit.', '.card', 'kit.card.extra', 'other.button', 'dp_other.card']) {
    assert.equal(addressFor(requested), null, `"${requested}" produced an address`)
  }
})

test('a reference that resolves addresses its own component, and no reference addresses the first', () => {
  assert.equal(addressFor('kit.button'), 'button')
  assert.equal(addressFor(null), 'alert')
})

// ── The App's address ─────────────────────────────────────────────────────
//
// A component's path names it by name alone — the App is the project — and the
// bare address still honours an old `?component=` reference with every answer
// above.

/** What the page asks for an App path, with an old link's reference beside it. */
const atAddress = (path: string, legacyRef: string | null = null) => selectForAddress(componentRouteOf(path), legacyRef, project, identities)

test('a component path opens that component, never the first', () => {
  assert.deepEqual(atAddress('/component/card'), { status: 'selected', name: 'card' })
})

test('a preview path selects the component it previews', () => {
  assert.deepEqual(atAddress('/component/card/preview/example:examples/x.tsx'), { status: 'selected', name: 'card' })
})

test('a component path naming nothing here is missing, quoting the name the address shows', () => {
  const selection = atAddress('/component/ghost')
  assert.deepEqual(selection, { status: 'missing', requested: 'ghost' })
  assert.equal(addressedComponent(selection), null)
})

test('a path that is no page of the App is missing, not the first component', () => {
  const selection = atAddress('/item/K-1')
  assert.deepEqual(selection, { status: 'missing', requested: '/item/K-1' })
  assert.equal(addressedComponent(selection), null)
})

test('a path is not overridden by an old reference riding along in the query', () => {
  assert.deepEqual(atAddress('/component/card', 'kit.button'), { status: 'selected', name: 'card' })
})

test('the bare address keeps every answer an old link had', () => {
  assert.deepEqual(atAddress('/'), { status: 'selected', name: 'alert' })
  assert.deepEqual(atAddress('/', 'kit.button'), { status: 'selected', name: 'button' })
  assert.deepEqual(atAddress('/', 'kit.ghost'), { status: 'missing', requested: 'kit.ghost' })
  assert.deepEqual(atAddress('/', 'other.button'), { status: 'other-project', requested: 'other.button', project: 'other' })
})

// ── The page that has to use it ───────────────────────────────────────────
//
// Everything above runs the rule. Nothing above can tell whether the page
// actually asks it, and the page cannot be imported here — it imports
// `@ext/host`, which is not a package this repo installs — so what follows
// reads its SOURCE and asserts the shape of the wiring.
//
// That is a weaker instrument and is not offered as anything else. It cannot
// see a render, so it cannot show that the message appears or that the address
// bar survives; those are a person in front of the screen. What it does catch
// is a second answer to "which component" growing back somewhere in the page,
// where the tests above would keep passing while the screen went wrong again.

const pageSource = readFileSync(new URL('../design-kit-app-view.tsx', import.meta.url), 'utf-8')

/** The page with its prose removed. The comments below quote the very patterns
 *  these guards forbid, so matching against the raw file would fail on the
 *  explanation of why the code does not do that. */
const page = pageSource.replace(/^\s*(\/\/|\*|\/\*).*$/gm, '')

test('the page asks the rule rather than carrying its own copy', () => {
  assert.match(page, /from '\.\/components\/component-selection'/)
  assert.match(page, /selectForAddress\(route, legacyRef, items\.map/)
})

test('the page says the address is for another project, and does not say the component is absent', () => {
  // The sentence may only claim what the page established. It read a project
  // half and compared it; it never looked for the component anywhere, so
  // "not found" would be an absence it cannot support.
  const sentence = /The address names the design project "\$\{selection\.project\}", which is not this one\./
  assert.match(page, sentence)
  const branch = page.slice(page.indexOf("selection.status === 'other-project'"), page.indexOf('stored === null ?'))
  assert.ok(branch.length > 0, 'the other-project branch is gone or no longer precedes the failed-read one')
  assert.doesNotMatch(branch, /not found/, 'the other-project branch claims an absence it did not establish')
})

test('a list that could not be read is its own state, not an empty one', () => {
  // Arriving as the same value, the page would have to pick one of two
  // sentences, and both would be false when the read had failed.
  assert.match(page, /useState<StoredComponent\[\] \| null>/)
  assert.match(page, /\.catch\(\(\) => setStored\(null\)\)/)
  assert.doesNotMatch(page, /\.catch\(\(\) => setStored\(\[\]\)\)/, 'a failed read is rounded down to an empty project again')
  // A reply that is not a list is a read that produced none, not a project
  // with nothing in it.
  assert.doesNotMatch(page, /Array\.isArray\(list\) \? list : \[\]/, 'a non-list reply is read as an empty project')
})

test('the failed-read sentence is checked before any claim about the list', () => {
  // Every branch after it is a statement ABOUT the components, and none of
  // them is true when the list could not be read. Ordering is the whole guard:
  // put it last and it is unreachable, because a failed read leaves no item
  // and the branches above answer first — with the wrong sentence.
  const failed = page.indexOf('stored === null ?')
  const item = page.indexOf(') : item ? (')
  const missing = page.indexOf("selection.status === 'missing'")
  assert.ok(failed > 0, 'the page has no state for a list it could not read')
  assert.ok(failed < item, 'a component doc can render over a failed read')
  assert.ok(failed < missing, 'a failed read can still be reported as a component that does not exist')
})

test('the one branch that reads no list is the one branch allowed above the failed read', () => {
  // The rule above is about branches that make claims ABOUT the list, so the
  // test of what may precede it is not position but what the branch consults.
  // other-project is decided from the address and the project's identities,
  // both established while the list is unreadable — so its sentence is true
  // during the outage, and stays true after one, which the outage sentence
  // would not be for that reader.
  const otherProject = page.indexOf("selection.status === 'other-project'")
  const failed = page.indexOf('stored === null ?')
  assert.ok(otherProject > 0, 'the page no longer answers a cross-project address')
  assert.ok(otherProject < failed, 'an outage now answers a reader whose address could never have worked')
})

test('the page tells the rule everything its project answers to', () => {
  // Both halves, and the failure mode if only one is passed is quiet: an
  // address written with the id resolves today, and would start reading as
  // another project's the moment only the slug was compared.
  assert.match(page, /\[project\.slug, project\.id\]/)
  assert.match(page, /selectForAddress\(route, legacyRef, items\.map\(\(i\) => i\.name\), identities\)/)
})

test('the page writes the address only where the rule permits it', () => {
  // One call, behind the refusal, and only at the bare address: a path already
  // names its component, and a request that did not resolve (null) is left as
  // it arrived. A second call — or this one lifted out of the check — is
  // exactly how the rewrite would come back.
  assert.equal(page.split('navigate(legacyLinkTarget(').length - 1, 1, 'more than one address write')
  const refusal = page.indexOf("route.page === 'library' && addressName)")
  assert.ok(refusal > 0, 'the address write is no longer guarded by the refusal')
  assert.ok(page.indexOf('navigate(legacyLinkTarget(') > refusal, 'the address is written before the refusal is consulted')
  assert.match(page, /navigate\(legacyLinkTarget\(addressName, location\.search\), \{ replace: true \}\)/, 'the forward leaves an entry Back returns to, which only forwards again')
})

test('the page keeps no fallback of its own', () => {
  // A substitution is spelled `items[0]`, whether in an effect that writes it
  // back into state or in a `??` at render. Neither has a narrower version
  // that would be acceptable here.
  assert.doesNotMatch(page, /items\[0\]/, 'a fallback to the first component is back in the page')
})

test('the page does not read a reference apart from the rule', () => {
  // Parsing here is what would split "did not parse" from "is not here" into
  // two answers again, and only one of them would be wired to the refusal.
  assert.doesNotMatch(page, /parseComponentRef/, 'the page parses the reference itself')
})

test('the editor can only mount on a component that resolved', () => {
  // The costly half: a substitute reaching this line puts publish and discard
  // controls on a component nobody chose.
  assert.match(page, /\{editorOpen && item \?/)
})

test('picking from the tree asks in the same form a link does', () => {
  // The address is the only request: a pick moves the App to the component's
  // path, the same path the row links to, so a click cannot take a path a
  // deep link, a reload or Back does not.
  assert.doesNotMatch(page, /setRequested\(/, 'the page holds a request of its own beside the address')
  assert.match(page, /navigate\(componentAppPath\(name\)\)/)
  assert.match(page, /href: appHref\(componentAppPath\(i\.name\)\)/)
})

test('an address for another project is left alone, exactly as an unresolvable one is', () => {
  // The load-bearing half: the whole harm is the address being rewritten to
  // the component that got substituted.
  assert.equal(addressedComponent({ status: 'other-project', requested: 'other.button', project: 'other' }), null)
})

test('every status has an address answer', () => {
  // The switch is exhaustive by type, but a status added later without a case
  // would return undefined here, and undefined reaching the caller reads as
  // "no component" rather than as a hole.
  const all: ComponentSelection[] = [
    { status: 'selected', name: 'button' },
    { status: 'missing', requested: 'kit.ghost' },
    { status: 'other-project', requested: 'other.button', project: 'other' },
    { status: 'none' },
  ]
  for (const selection of all) {
    assert.notEqual(addressedComponent(selection), undefined, `${selection.status} has no answer`)
  }
})
