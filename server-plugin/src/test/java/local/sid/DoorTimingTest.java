package local.sid;

public final class DoorTimingTest {
    public static void main(String[] args) {
        check(DoorTiming.escapeScore(1, false, true) < DoorTiming.escapeScore(4, true, true), "Exit goal wins over roof preference");
        check(DoorTiming.escapeScore(4, true, false) < DoorTiming.escapeScore(1, false, false), "No goal prefers shelter");
        check(!DoorTiming.shouldClose(400, 0, false, false), "Must not close during approach");
        check(!DoorTiming.shouldClose(6000, 0, true, false), "No forced close on slow occupant");
        check(!DoorTiming.shouldClose(5000, 4900, false, false), "Repeated path demand keeps open");
        check(!DoorTiming.shouldClose(6199, 5000, false, false), "Full clear interval required");
        check(DoorTiming.shouldClose(6200, 5000, false, false), "Close after passage clears");
        check(!DoorTiming.shouldClose(1000, 2000, false, false), "Clock rollback must not slam door");
        check(DoorTiming.shouldClose(100, 0, false, true), "Animal: close immediately when clear");
        check(!DoorTiming.shouldClose(3900, 0, true, true), "Animal: briefly allow occupied passage");
        check(DoorTiming.shouldClose(4000, 0, true, true), "Animal: preserve original forced-close cap");
        System.out.println("DoorTiming: 11 checks passed");
    }
    private static void check(boolean ok, String message) {
        if (!ok) throw new AssertionError(message);
    }
}
