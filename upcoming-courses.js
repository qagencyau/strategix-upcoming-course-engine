/**
 * Strategix — Upcoming Courses page logic
 *
 * Handles:
 *   1. CMS grouping & sorting of course intakes by course name/code
 *   2. Domain-based filtering (data-filter-ids attribute on main list)
 *   3. Date filtering on intake dates (engine-owned, not Finsweet's)
 *   4. "Continuous intake" handling (items with no intake date always pass)
 *
 * Why the engine owns date filtering (and not Finsweet): Finsweet v2 does not
 * index fields from nested child lists as fields of the parent. The intake-date
 * element lives inside each intake row, which is nested inside a course card.
 * Finsweet's filter ends up trying to match a non-existent field on the parent
 * items and removes every item from the DOM. This engine detaches Finsweet's
 * date filter (strips fs-list-* attrs from the datepicker inputs) and compares
 * dates per-intake-row via wrapperMatchesDate().
 *
 * NOT handled here (kept on-page per vendor instructions):
 *   - fengyuanchen datepicker init + visible/hidden input sync
 *   - fs-list-element="clear" button sync with the visible datepicker
 *
 * Requires (loaded separately by Webflow):
 *   - jQuery (Webflow loads this by default)
 *
 * DOM expectations:
 *   - Main list:                .state-courses_list
 *       optional attribute:     data-filter-ids="402, 403"  (restricts by domain-id)
 *   - Course card:              .state-courses_item
 *       heading:                .heading-style-h5
 *       domain marker:          [data="domain-id"]
 *       course code:            [fs-list-field="qual-code"]
 *       master CTA:             #course-link
 *   - Intake wrapper:           .w-dyn-item  (contains [data="enrolment-item"])
 *       status attribute:       status="true|false"
 *       vacancy attribute:      vacancy="<number>"
 *       filter date element:    [fs-list-field="intake-date"][fs-list-fieldtype="date"]  (YYYY-MM-DD text)
 *       sort date element:      [data-sort="intake-date"]  (YYYY-MM-DD text)
 *       continuous marker:      [data-continuous-intake]  (presence only, on the
 *                               "Continuous intake" text label — Webflow conditional
 *                               visibility renders it only when intake-date is empty)
 *   - Hidden course directory:  .course-directory-hidden  (name → URL lookup)
 *   - Inputs:
 *       visible datepicker:     #Date-display  (fengyuanchen, format dd-mm-yyyy)
 *       hidden filter input:    #Date          (fs-list-field="intake-date", ISO value)
 *       optional search:        #Search
 *   - Clear button:             [fs-list-element="clear"]
 *   - Load-more per row:        .enrol-load-more
 *
 * Repo: https://github.com/qagencyau/strategix-upcoming-course-engine
 * Version: 1.1.0 (continuous-intake via placeholder-date injection)
 */

(function () {
  'use strict';

  // Version marker — check `window.__strategixEngine` in console to confirm
  // which build the browser is actually running. Bump on every deploy.
  window.__strategixEngine = { version: '1.2.0', loadedAt: new Date().toISOString() };

  // ============================================================================
  // SECTION 1 — CORE COURSE LIST LOGIC
  // ============================================================================

  var isExpanding = false;
  var globalDebounceTimer;

  function rebuildEnrolmentUrls() {
    document.querySelectorAll('[data="enrolment-item"]').forEach(function (item) {
      var btn = item.querySelector('[data="enrolment"]');
      var cId = item.querySelector('[data="course-id"]') && item.querySelector('[data="course-id"]').innerText.trim();
      var cType = item.querySelector('[data="course-type"]') && item.querySelector('[data="course-type"]').innerText.trim();
      var iId = item.querySelector('[data="instance-id"]') && item.querySelector('[data="instance-id"]').innerText.trim();
      var domainId = item.querySelector('[data="domain-id"]') && item.querySelector('[data="domain-id"]').innerText.trim();

      if (btn && cId && cType && iId) {
        var path = domainId === '2159' ? '/international/' : '/';
        btn.setAttribute(
          'href',
          'https://enrol.strategix.edu.au' + path +
            '?course_id=' + cId +
            '&course_type=' + cType +
            '&instance_id=' + iId
        );
      }
    });
  }

  function cleanCourseName(name) {
    if (!name) return '';
    return name
      .toLowerCase()
      .replace(/ - night course/g, '')
      .replace(/ – night course/g, '')
      .replace(/\(.*\)/g, '')
      .replace(/[^a-z0-9]/g, '')
      .trim();
  }

  // Reads the hidden ISO datepicker input. Returns an object describing the
  // active date filter, or { active: false } if no date is set or unparseable.
  function getDateFilterState() {
    var input = document.querySelector('#Date');
    var raw = (input && input.value && input.value.trim()) || '';
    if (!raw) return { active: false, date: null, operator: 'greater-equal' };

    var iso = raw.replace(/\//g, '-'); // accept YYYY-MM-DD or YYYY/MM/DD
    var d = new Date(iso);
    if (isNaN(d.getTime())) return { active: false, date: null, operator: 'greater-equal' };
    d.setHours(0, 0, 0, 0);

    return {
      active: true,
      date: d,
      operator: input.getAttribute('fs-list-operator') || 'greater-equal'
    };
  }

  // Does this intake wrapper's date satisfy the active date filter?
  // Returns true if there's no active filter or the date element is missing,
  // so we never over-filter when markup is incomplete.
  function wrapperMatchesDate(wrapper, state) {
    if (!state.active) return true;

    var dateEl = wrapper.querySelector('[fs-list-field="intake-date"][fs-list-fieldtype="date"]');
    if (!dateEl) return true;

    var d = new Date(dateEl.textContent.trim());
    if (isNaN(d.getTime())) return true;
    d.setHours(0, 0, 0, 0);

    switch (state.operator) {
      case 'greater':       return d >  state.date;
      case 'greater-equal': return d >= state.date;
      case 'less':          return d <  state.date;
      case 'less-equal':    return d <= state.date;
      case 'equal':         return d.getTime() === state.date.getTime();
      case 'not-equal':     return d.getTime() !== state.date.getTime();
      default:              return d >= state.date;
    }
  }

  function applyAutomatedDataLogic() {
    if (isExpanding) return;

    var mainList = document.querySelector('.state-courses_list');
    if (!mainList) return;

    // 0. Allowed domain IDs (component attribute data-filter-ids="402, 403")
    var rawAllowedIds = mainList.getAttribute('data-filter-ids');
    var allowedIds = rawAllowedIds ? rawAllowedIds.split(',').map(function (id) { return id.trim(); }) : [];

    // Filter state flags
    var searchInput = document.querySelector('#Search');
    var isSearching = searchInput && searchInput.value.trim().length > 0;
    var dateFilter = getDateFilterState();
    var isDateFiltered = dateFilter.active;
    var bypassTopThree = isSearching || isDateFiltered; // when filtering, lift the "first 3 only" cap

    // 1. Build directory map (course name/code → URL) from hidden directory list
    var nameToUrlMap = {};
    var codeToUrlMap = {};
    document.querySelectorAll('.course-directory-hidden .w-dyn-item').forEach(function (item) {
      var rawName = item.querySelector('[data-dir="name"]') && item.querySelector('[data-dir="name"]').innerText.trim();
      var rawCode = item.querySelector('[data-dir="course-code"]') && item.querySelector('[data-dir="course-code"]').innerText.trim().toUpperCase();
      var urlEl = item.querySelector('[data-dir="url"]');
      var url = urlEl && urlEl.getAttribute('href');
      if (url) {
        if (rawName) nameToUrlMap[cleanCourseName(rawName)] = url;
        if (rawCode) codeToUrlMap[rawCode] = url;
      }
    });

    var sessionItems = document.querySelectorAll('.state-courses_item');
    var courseGroups = {};

    // 2. PHASE 1 — Domain filtering & grouping
    sessionItems.forEach(function (item) {
      // Domain filter: kill items from disallowed domains entirely
      var itemDomainId = item.querySelector('[data="domain-id"]') && item.querySelector('[data="domain-id"]').innerText.trim();
      if (allowedIds.length > 0 && allowedIds.indexOf(itemDomainId) === -1) {
        item.remove();
        return;
      }

      var headingEl = item.querySelector('.heading-style-h5');
      var codeEl = item.querySelector('[fs-list-field="qual-code"]');
      if (!headingEl) return;

      var cleanedHeading = cleanCourseName(headingEl.innerText.trim());
      var rawCode = codeEl ? codeEl.innerText.trim().toUpperCase() : '';
      var autoUrl = nameToUrlMap[cleanedHeading] || codeToUrlMap[rawCode];

      var masterBtn = item.querySelector('#course-link');
      if (masterBtn && autoUrl) masterBtn.setAttribute('href', autoUrl);

      var groupKey = cleanedHeading || rawCode;

      if (!courseGroups[groupKey]) {
        courseGroups[groupKey] = item;
        var nt = item.querySelector('.enrollment-list');
        if (nt) nt.setAttribute('fs-list-nest', 'enrol-dates');
      } else {
        var masterItem = courseGroups[groupKey];
        var masterListEl = masterItem.querySelector('[data-list="enrollments"]');
        var itemsToMove = item.querySelectorAll('.w-dyn-item');
        if (masterListEl && itemsToMove.length > 0) {
          itemsToMove.forEach(function (enrol) { masterListEl.appendChild(enrol); });
          item.remove();
        }
      }
    });

    // 3. PHASE 1.5 — Sort nested intake items chronologically
    document.querySelectorAll('[data-list="enrollments"]').forEach(function (container) {
      var items = Array.prototype.slice.call(container.querySelectorAll('.w-dyn-item'));
      items.sort(function (a, b) {
        var aEl = a.querySelector('[data-sort="intake-date"]');
        var bEl = b.querySelector('[data-sort="intake-date"]');
        var dateA = (aEl && aEl.innerText.trim()) || '9999-12-31';
        var dateB = (bEl && bEl.innerText.trim()) || '9999-12-31';
        return dateA.localeCompare(dateB);
      });
      items.forEach(function (item) { container.appendChild(item); });
    });

    // 4. PHASE 1.7 — Global parent sort by each course's soonest upcoming intake
    var allParentCards = Array.prototype.slice.call(mainList.querySelectorAll('.state-courses_item'));
    allParentCards.sort(function (cardA, cardB) {
      function getSoonestDate(card) {
        var dateEls = Array.prototype.slice.call(card.querySelectorAll('[data-sort="intake-date"]'));
        var validDates = dateEls
          .map(function (el) { return el.innerText.trim(); })
          .filter(function (val) { return val !== '' && val.indexOf('-') !== -1; });
        return validDates.length > 0 ? validDates[0] : '9999-12-31';
      }
      return getSoonestDate(cardA).localeCompare(getSoonestDate(cardB));
    });
    allParentCards.forEach(function (card) { mainList.appendChild(card); });

    // 5. PHASE 2 — Per-row display, date filter, load-more
    var activeRows = document.querySelectorAll('.state-courses_item');
    activeRows.forEach(function (row) {
      var intakes = Array.prototype.slice.call(row.querySelectorAll('[data="enrolment-item"]'));
      var validIntakes = [];

      intakes.forEach(function (enrol) {
        var status = enrol.getAttribute('status') && enrol.getAttribute('status').toLowerCase() === 'true';
        var vacancyValue = Number(enrol.getAttribute('vacancy') || '1');
        var wrapper = enrol.closest('.w-dyn-item');
        if (!wrapper) return;

        var passesStatus = status && vacancyValue > 0;
        var passesDate = wrapperMatchesDate(wrapper, dateFilter);

        if (passesStatus && passesDate) {
          validIntakes.push(wrapper);
        } else {
          wrapper.style.display = 'none';
        }
      });

      validIntakes.forEach(function (wrapper, index) {
        if (bypassTopThree) {
          wrapper.style.display = 'flex';
          wrapper.classList.remove('is-hidden-intake');
        } else if (index >= 3) {
          wrapper.style.display = 'none';
          wrapper.classList.add('is-hidden-intake');
        } else {
          wrapper.style.display = 'flex';
          wrapper.classList.remove('is-hidden-intake');
        }
      });

      var btn = row.querySelector('.enrol-load-more');
      if (btn) {
        if (bypassTopThree || validIntakes.length <= 3) {
          btn.style.display = 'none';
        } else {
          btn.style.display = 'block';
          btn.innerText = 'Show All (' + validIntakes.length + ')';
          if (!btn.dataset.listener) {
            btn.addEventListener('click', function (e) {
              e.preventDefault();
              isExpanding = true;
              row.querySelectorAll('.is-hidden-intake').forEach(function (h) { h.style.display = 'flex'; });
              btn.style.display = 'none';
              setTimeout(function () { isExpanding = false; }, 500);
            });
            btn.dataset.listener = 'true';
          }
        }
      }

      row.style.display = validIntakes.length > 0 ? 'block' : 'none';
    });

    rebuildEnrolmentUrls();
  }

  // ----------------------------------------------------------------------------
  // Patch continuous-intake items with a sentinel date so sort places them last.
  //
  // Our engine's wrapperMatchesDate() will always let continuous items pass the
  // date filter (since 9999-12-31 >= any real date under greater-equal), and the
  // sort logic already falls back to 9999-12-31 for missing dates, so this is
  // mostly cosmetic — but it keeps DOM state consistent with what the engine
  // treats internally.
  //
  // Idempotent: if the date field already has content we don't touch it.
  // ----------------------------------------------------------------------------
  var CONTINUOUS_PLACEHOLDER_DATE = '9999-12-31';

  function patchContinuousIntakes() {
    var markers = document.querySelectorAll('[data-continuous-intake]');
    markers.forEach(function (marker) {
      var wrapper = marker.closest('.w-dyn-item');
      if (!wrapper) return;
      var dateEl = wrapper.querySelector('[fs-list-field="intake-date"][fs-list-fieldtype="date"]');
      if (!dateEl) return;
      if (dateEl.textContent.trim() === '') {
        dateEl.textContent = CONTINUOUS_PLACEHOLDER_DATE;
      }
    });
  }

  // ----------------------------------------------------------------------------
  // Detach Finsweet's intake-date filter and let our engine own date filtering.
  //
  // Why: Finsweet v2 does NOT index `intake-date` as a field on parent course
  // items (verified via inst.allFieldsData.value — only includes name, state,
  // qual-code, location-address, qualification-id). The field lives inside the
  // nested intake items. When a user picks a date, Finsweet tries to match a
  // field that doesn't exist on any item, so every item fails the filter and
  // gets wiped from the DOM. That's how "all items disappear on filter" happens.
  //
  // Fix: strip fs-list-* from both #Date (hidden, ISO) and #Date-display
  // (visible, DD-MM-YYYY) so Finsweet stops trying to apply the intake-date
  // filter entirely. Our engine's wrapperMatchesDate() handles the comparison
  // per-intake-row, which correctly reaches into the nested date elements.
  //
  // We also call Finsweet's list.restart() after detaching so any state
  // Finsweet captured before detach gets cleared.
  // ----------------------------------------------------------------------------
  function detachFinsweetDateFilter() {
    var inputs = document.querySelectorAll(
      'input[fs-list-field="intake-date"], input[fs-list-fieldtype="date"]'
    );
    inputs.forEach(function (inp) {
      inp.removeAttribute('fs-list-field');
      inp.removeAttribute('fs-list-fieldtype');
      inp.removeAttribute('fs-list-operator');
    });
  }

  // Wait for Finsweet's list module to be ready, then detach + restart. Using
  // modules.list.loading (a promise) rather than the push queue because by the
  // time our defer script runs, FinsweetAttributes may already be the
  // initialized object (not an array), and restart() cleanly rebuilds state.
  function syncWithFinsweet() {
    var fs = window.FinsweetAttributes;
    if (fs && fs.modules && fs.modules.list && fs.modules.list.loading
        && typeof fs.modules.list.loading.then === 'function') {
      fs.modules.list.loading.then(function () {
        detachFinsweetDateFilter();
        if (typeof fs.modules.list.restart === 'function') {
          fs.modules.list.restart();
        }
      });
      return;
    }
    // Finsweet not loaded yet — try again shortly.
    setTimeout(syncWithFinsweet, 150);
  }

  // ----------------------------------------------------------------------------
  // Observer: re-run on CMS child changes (Finsweet re-render, etc.)
  // ----------------------------------------------------------------------------
  function initObserverAndListeners() {
    // Detach Finsweet's intake-date filter (strips fs-list-* from inputs) and
    // patch continuous items with the sentinel date. Both idempotent.
    detachFinsweetDateFilter();
    patchContinuousIntakes();

    // Also detach + restart once Finsweet finishes loading, to clear any filter
    // state Finsweet captured from the inputs before we stripped them.
    syncWithFinsweet();

    var mainObserver = new MutationObserver(function (mutations) {
      if (isExpanding) return;
      if (mutations.some(function (m) { return m.addedNodes.length > 0; })) {
        // Re-detach (Finsweet sometimes re-decorates inputs) and re-patch items.
        detachFinsweetDateFilter();
        patchContinuousIntakes();
        clearTimeout(globalDebounceTimer);
        globalDebounceTimer = setTimeout(applyAutomatedDataLogic, 400);
      }
    });

    var targetContainer = document.querySelector('.state-courses_list');
    if (targetContainer) mainObserver.observe(targetContainer, { childList: true, subtree: true });

    // Search input (if present)
    var sInp = document.querySelector('#Search');
    if (sInp) {
      sInp.addEventListener('input', function () {
        clearTimeout(globalDebounceTimer);
        globalDebounceTimer = setTimeout(applyAutomatedDataLogic, 100);
      });
    }

    // Hidden ISO datepicker input — Finsweet reads this directly,
    // and so does applyAutomatedDataLogic via getDateFilterState().
    var dInp = document.querySelector('#Date');
    if (dInp) {
      ['input', 'change'].forEach(function (evt) {
        dInp.addEventListener(evt, function () {
          clearTimeout(globalDebounceTimer);
          globalDebounceTimer = setTimeout(applyAutomatedDataLogic, 100);
        });
      });
    }
  }

  // ============================================================================
  // BOOTSTRAP
  // ============================================================================
  // Run observer/listener setup as soon as the DOM is ready.
  // Run applyAutomatedDataLogic once after full load (+ 1s buffer for Finsweet).

  function onReady(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn);
    } else {
      fn();
    }
  }

  // Detach Finsweet's intake-date filter and patch continuous items as early as
  // possible. Safe to call even if DOM isn't fully parsed — querySelectorAll
  // just returns what exists so far, and initObserverAndListeners will catch
  // the rest on DOMContentLoaded.
  detachFinsweetDateFilter();
  patchContinuousIntakes();

  onReady(initObserverAndListeners);

  // Initial course list render. window.load fires after all resources (incl.
  // Webflow's CMS nesting) settle; the 1s buffer gives Finsweet time to paint.
  if (document.readyState === 'complete') {
    setTimeout(applyAutomatedDataLogic, 1000);
  } else {
    window.addEventListener('load', function () { setTimeout(applyAutomatedDataLogic, 1000); });
  }
})();