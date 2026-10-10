// Which component a page shows, and what the address is allowed to say about
// it.
//
// These are one decision and not two, because the defect they exist to prevent
// is the two coming apart. A page that answers "which component" with a
// fallback and then writes THAT answer into the address bar has destroyed the
// only record that something else was asked for: the reader sees a component
// they did not choose, under an address that agrees with the screen, and the
// link they copy out of the bar sends the next person to the substitute rather
// than to what they meant to share. Keeping both answers in one place is what
// stops a later caller from deriving the address off whatever ended up
// rendered.
//
// The rule this holds, in one sentence: the page never rewrites an address it
// could not resolve, and never shows something other than what was asked for.
//
//   nothing asked for       show the first component, and let the address name
//                           it. A bare project link turning into a component
//                           link fills something in rather than erasing it.
//
//   asked for, and it       show it, and let the address name it. Writing it
//   resolves                back only normalises the reference's spelling — it
//                           cannot change which component is addressed.
//
//   asked for, and it       show nothing, and LEAVE THE ADDRESS UNTOUCHED.
//   does not resolve        Not cleared and not repointed at the first
//                           component: the request is the only surviving
//                           record that it was made, and the person has to be
//                           able to read back what they asked for.
//
// The third case is why this module exists. The first two are here so the rule
// has no gap for a caller to close with a `??`.
//
// ── Which project the reference is for ────────────────────────────────────
//
// A reference names a project as well as a component, and both halves have to
// be honoured. Reading only the name would make an address for another
// project's component open this project's component of the same name, and
// then rewrite the address to agree — the same harm as a name that does not
// exist, reached without anything being missing, and invisible to a check that
// only asks whether the name is in the list, because it is.
//
// The project half is compared against what this page's project answers to,
// which is more than one string: the grammar accepts a namespace slug or a
// storage id as the first half, so a page addressed either way has to resolve.
// What this deliberately does NOT do is ask whether the project named exists
// somewhere else. That would be a lookup, and it would only change what the
// page can SAY, never what it can show — this page is one project, and an
// address for another one does not resolve here whatever the answer.
//
// ── Why the test is "was something asked for", not "did it parse" ──────────
//
// A reference that does not parse and a reference naming a component this
// project does not hold are the same event — something was asked for and it is
// not here — so they get the same answer, and there is one branch rather than
// two. This matters beyond tidiness: a `?component=button` with no project half
// is NOT a third form of reference to be read leniently as a bare name. The
// grammar in ../registry/component-ref.ts is deliberately two-part, and quietly
// accepting a one-part form here would invent a spelling that nothing else in
// this codebase reads, on the surface whose job is to refuse what it cannot
// resolve.
//
// ── The seam ──────────────────────────────────────────────────────────────
//
// This takes the reference as GIVEN rather than a name already picked out of
// it, so that the project half has somewhere to be checked — against
// `identities`, below. Any further reason a request does not resolve belongs
// INSIDE this function, and not as a second answer somewhere up the call.

import { parseComponentRef } from '../registry/component-ref.ts'
import type { ComponentRoute } from './component-routes.ts'

/**
 * What a page should show for a requested component.
 *
 * `missing` carries the reference EXACTLY as it was asked for, not the name
 * parsed out of it. Two reasons, and both are about the reader: the address bar
 * still shows that string, so a message quoting anything else reads as being
 * about a different request, and a reference that failed to parse has no name
 * to quote in the first place.
 */
export type ComponentSelection =
  | { status: 'selected'; name: string }
  | { status: 'missing'; requested: string }
  | { status: 'other-project'; requested: string; project: string }
  | { status: 'none' }

/**
 * The component to show, given the reference that was asked for, the names the
 * project holds, and the names that project answers to.
 *
 * `requested` is the address's component reference as it arrived — null when
 * the address carried none. An empty string counts as none rather than as a
 * failed request: `?component=` names nothing, so there is nothing to report
 * as not found, and the page should open as it does with no parameter at all.
 *
 * `identities` is every string this page's project can legitimately be
 * addressed by — its namespace slug and its storage id, because the grammar
 * accepts either as a reference's first half. A reference whose first half is
 * none of them is not addressing this page, and the fact that a component of
 * that NAME happens to be here is a coincidence rather than a resolution.
 *
 * Empty `identities` means the page does not yet know what it is, which is not
 * the same as knowing the reference is wrong — but both end here, because a
 * page that cannot say whether an address is for it must not act as though it
 * is. Nothing is lost: a page in that state has nothing to show and no address
 * to write either.
 *
 * A request that resolves to nothing is `missing` even when the project is
 * empty. The two are different sentences — "you asked for something that is not
 * here" and "there is nothing here" — and an empty project does not retract a
 * request.
 */
export function selectComponent(
  requested: string | null,
  names: readonly string[],
  identities: readonly string[],
): ComponentSelection {
  if (!requested) {
    return names.length > 0 ? { status: 'selected', name: names[0] } : { status: 'none' }
  }
  // One site, three reasons a request does not resolve: it is not a reference,
  // it names another project, or it names a component this one does not hold.
  // Three branches, still one place that answers — two places answering "which
  // component" can disagree, and a reader of either would not see it.
  //
  // They are separate outcomes rather than one because the page can say
  // something true and specific about the middle case and nothing of the sort
  // about the others: it knows which project was asked for, and it knows that
  // is not this one.
  const ref = parseComponentRef(requested)
  if (!ref) {
    return { status: 'missing', requested }
  }
  if (!identities.includes(ref.project)) {
    // With nothing to compare against, the page does not know what it is, and
    // "that is another project" is a claim it cannot support — only "I cannot
    // resolve this" is. The distinction costs one branch and stops the page
    // telling somebody their own project is somebody else's while it loads.
    return identities.length > 0
      ? { status: 'other-project', requested, project: ref.project }
      : { status: 'missing', requested }
  }
  return names.includes(ref.name) ? { status: 'selected', name: ref.name } : { status: 'missing', requested }
}

/**
 * The component to show for the App's address: its path, or — at the bare
 * address only — the reference an old `?component=` link carries.
 *
 * A path names a component of this project by name alone, so it has no project
 * half to check and resolves or is `missing`, quoting the name as the address
 * shows it. A path that is no page of this App is `missing` too, quoting the
 * path: something was asked for and it is not here. Only the bare address falls
 * back to the reference and then to the first component, through
 * `selectComponent`, so the old links keep every answer they had.
 */
export function selectForAddress(
  route: ComponentRoute,
  legacyRef: string | null,
  names: readonly string[],
  identities: readonly string[],
): ComponentSelection {
  switch (route.page) {
    case 'library':
      return selectComponent(legacyRef, names, identities)
    case 'component':
    case 'preview':
      return names.includes(route.name)
        ? { status: 'selected', name: route.name }
        : { status: 'missing', requested: route.name }
    case 'unknown':
      return { status: 'missing', requested: route.path }
  }
}

/**
 * The component the address should name, or `null` when the address must be
 * left exactly as it arrived.
 *
 * The two empty-ish answers are deliberately not the same value, and a caller
 * that collapses them overwrites a failed request: `''` means "no component is
 * addressed, clear the reference", which is right when nothing was asked for,
 * and `null` means "do not write here at all", which is the only correct answer
 * once a request has failed. Erasing a failed request is a quieter version of
 * overwriting it — the reader still cannot see what they typed.
 */
export function addressedComponent(selection: ComponentSelection): string | null {
  switch (selection.status) {
    case 'selected':
      return selection.name
    case 'none':
      return ''
    case 'missing':
    case 'other-project':
      return null
  }
}
