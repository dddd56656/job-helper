// Userscript bootstrap. The panel is intentionally opt-in through the floating
// control; it never starts a delivery run without a user click.
(function bootstrap() {
    if (typeof window === 'undefined' || !window.DeliveryScheduler) return;
    const scheduler = new window.DeliveryScheduler();
    const panel = new window.DeliveryPanel(scheduler).mount();
    new window.SchedulerFab(scheduler).mount();
    window.JobHelperPipeline = { scheduler, panel };
})();
