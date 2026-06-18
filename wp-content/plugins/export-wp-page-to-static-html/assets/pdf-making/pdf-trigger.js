/**
 * WP to HTML — PDF Trigger
 *
 * Waits for all page resources (including any AJAX calls) to finish, then
 * uses html2pdf.js to capture the page and trigger a download.
 *
 * Vars injected via wp_localize_script (wpToHtmlPdf):
 *   filename  — clean basename for the downloaded file (no .pdf extension)
 *   ajax_url  — admin-ajax.php URL
 *   nonce     — wp_to_html_pdf_nonce
 */
(function () {
    'use strict';

    var triggered = false;

    function doGenerate() {
        if (triggered) return;
        triggered = true;

        var el = document.getElementById('page') || document.body;

        html2pdf()
            .set({
                margin: 10,
                filename: (wpToHtmlPdf.filename || 'page') + '.pdf',
                image: { type: 'jpeg', quality: 0.99 },
                html2canvas: { scale: 2, useCORS: true },
                jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
            })
            .from(el)
            .save()
            .then(function () {
                // Hide the "Generating…" modal once done.
                var modal = document.getElementById('wth-pdf-modal');
                if (modal) modal.style.display = 'none';

                // Increment the daily counter (fire-and-forget).
                if (typeof jQuery !== 'undefined' && wpToHtmlPdf.ajax_url) {
                    jQuery.post(wpToHtmlPdf.ajax_url, {
                        action: 'wp_to_html_increment_pdf_count',
                        nonce:  wpToHtmlPdf.nonce,
                    });
                }
            });
    }

    // Wait for page + any in-flight jQuery AJAX to settle before capturing.
    window.addEventListener('load', function () {
        if (typeof jQuery !== 'undefined') {
            var ajaxPending = false;

            jQuery(document).ajaxStart(function () { ajaxPending = true; });
            jQuery(document).ajaxStop(function () {
                ajaxPending = false;
                if (!triggered) setTimeout(doGenerate, 200);
            });

            // Fallback: trigger after 1 s if no AJAX was detected.
            setTimeout(function () {
                if (!ajaxPending && !triggered) doGenerate();
            }, 1000);
        } else {
            doGenerate();
        }
    });
})();
