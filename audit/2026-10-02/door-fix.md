# Home doorway fix (2.14.1)

Ordinary doors: refresh demand while an actor on a matching path approaches; close only after 1.2 seconds clear. Never adopt doors already opened by players. Human occupants also prevent normal closure.

Animal containment: retain cached pen-door avoidance and the existing immediate-clear / four-second occupied forced close. Add a fresh nearby-animal check before automatic opening. This change does not relax pen protections.

Verification: Gradle offline build and nine executable Java policy checks pass. Existing Citizens deprecated useNewPathfinder warning remains. Live home crossing and animal containment require gameplay observation.

Deployment: back up installed 2.14.0 JAR, announce at least 60 seconds, restart Paper through Wings, verify loaded version and automatic runtime reconnection. Rollback is previous JAR plus same announced restart procedure.

Live verification: Paper enabled SIDLocal 2.14.1 at 10:26:35 UTC; bridge ready, snapshot age zero, 18 online citizens. Previous JAR: /opt/sid-staged/SIDLocal-before-door-fix-20261002-102626.jar on ct120. No player home crossing or animal escape test was performed.
