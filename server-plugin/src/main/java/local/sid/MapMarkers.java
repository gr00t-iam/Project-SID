package local.sid;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import de.bluecolored.bluemap.api.BlueMapAPI;
import de.bluecolored.bluemap.api.BlueMapMap;
import de.bluecolored.bluemap.api.markers.HtmlMarker;
import de.bluecolored.bluemap.api.markers.Marker;
import de.bluecolored.bluemap.api.markers.MarkerSet;
import de.bluecolored.bluemap.api.markers.POIMarker;
import de.bluecolored.bluemap.api.markers.ShapeMarker;
import de.bluecolored.bluemap.api.math.Color;
import de.bluecolored.bluemap.api.math.Shape;
import org.bukkit.World;

import java.util.*;

/**
 * Live BlueMap layers for the town: every citizen (with a brain that pulses while the citizen is thinking), the
 * buildings, homes, sites and farm plots, damage being repaired, and resources the citizens remember (trees, ores).
 * Only loaded when BlueMap is installed (SIDLocal soft-depends on it).
 */
final class MapMarkers {
    record Citizen(String id, String name, double x, double y, double z, String status, boolean thinking, String thought) {}

    private static final String STYLE = "<style>@keyframes sidthink{0%,100%{transform:scale(1);filter:drop-shadow(0 0 1px #000)}"
        + "50%{transform:scale(1.35);filter:drop-shadow(0 0 7px #ff5cdb)}}.sid-c{transform:translate(-50%,-100%);text-align:center;"
        + "font:600 12px system-ui,sans-serif;color:#fff;text-shadow:0 0 3px #000,0 0 2px #000;white-space:nowrap;pointer-events:auto}"
        + ".sid-c .b{font-size:20px;line-height:22px;display:inline-block}.sid-c .b.on{animation:sidthink .9s ease-in-out infinite}"
        + ".sid-c .b.off{opacity:.35;filter:grayscale(1)}.sid-c .s{font-weight:400;opacity:.85;font-size:11px}</style>";

    private final World world;
    private volatile BlueMapAPI api;
    private final MarkerSet citizens = MarkerSet.builder().label("Citizens").toggleable(true).defaultHidden(false).build();
    private final MarkerSet places = MarkerSet.builder().label("Buildings & sites").toggleable(true).defaultHidden(false).build();
    private final MarkerSet resources = MarkerSet.builder().label("Known resources").toggleable(true).defaultHidden(true).build();

    MapMarkers(World world) {
        this.world = world;
        BlueMapAPI.onEnable(a -> { api = a; attach(); });
        BlueMapAPI.onDisable(a -> api = null);
    }

    private void attach() {
        BlueMapAPI a = api;
        if (a == null) return;
        a.getWorld(world).ifPresent(w -> {
            Collection<BlueMapMap> maps = w.getMaps();
            // The overworld map only (26.x keeps every dimension under one world).
            List<BlueMapMap> target = maps.stream().filter(m -> !m.getId().contains("nether") && !m.getId().contains("end")).toList();
            for (BlueMapMap m : target.isEmpty() ? maps : target) {
                m.getMarkerSets().put("sid-citizens", citizens);
                m.getMarkerSets().put("sid-places", places);
                m.getMarkerSets().put("sid-resources", resources);
            }
        });
    }

    private static String esc(String s) {
        return s == null ? "" : s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;");
    }

    /** Called once a second with every spawned citizen. */
    void citizens(List<Citizen> list) {
        if (api == null) return;
        Set<String> keep = new HashSet<>();
        for (Citizen c : list) {
            String key = "cit-" + c.id();
            keep.add(key);
            String status = c.status() == null ? "" : c.status().replaceAll("§.", "");
            if (status.length() > 48) status = status.substring(0, 47) + "…";
            String html = STYLE + "<div class=\"sid-c\" title=\"" + esc(c.thinking() ? "Thinking: " + c.thought() : c.thought()) + "\">"
                + "<span class=\"b " + (c.thinking() ? "on" : "off") + "\">🧠</span><br>" + esc(c.name())
                + (status.isBlank() ? "" : "<br><span class=\"s\">" + esc(status) + "</span>") + "</div>";
            Marker existing = citizens.getMarkers().get(key);
            if (existing instanceof HtmlMarker h) {
                h.setPosition(c.x(), c.y() + 2.2, c.z());
                h.setHtml(html);
                h.setLabel(c.name());
            } else {
                citizens.getMarkers().put(key, HtmlMarker.builder().label(c.name()).position(c.x(), c.y() + 2.2, c.z()).html(html).build());
            }
        }
        citizens.getMarkers().keySet().removeIf(k -> !keep.contains(k));
    }

    private static Color color(String kind, float alpha) {
        return switch (kind) {
            case "home" -> new Color(90, 170, 255, alpha);
            case "farm" -> new Color(120, 200, 80, alpha);
            case "site" -> new Color(255, 190, 60, alpha);
            case "damage" -> new Color(255, 70, 60, alpha);
            case "zone" -> new Color(200, 200, 200, alpha);
            default -> new Color(230, 120, 255, alpha);   // built public works
        };
    }

    /**
     * From the runtime: {places:[{id,label,detail,kind,x1,z1,x2,z2,y}], points:[{id,label,detail,kind,x,y,z}],
     * resources:[{id,label,x,y,z}]}. Each list replaces its layer.
     */
    void update(JsonObject spec) {
        if (api == null || spec == null) return;
        if (spec.has("places") || spec.has("points")) {
            Map<String, Marker> next = new HashMap<>();
            for (JsonElement e : spec.has("places") ? spec.getAsJsonArray("places") : new JsonArray()) {
                JsonObject p = e.getAsJsonObject();
                String kind = str(p, "kind");
                double x1 = p.get("x1").getAsDouble(), z1 = p.get("z1").getAsDouble(), x2 = p.get("x2").getAsDouble() + 1, z2 = p.get("z2").getAsDouble() + 1;
                next.put("place-" + str(p, "id"), ShapeMarker.builder().label(str(p, "label")).detail(esc(str(p, "detail")))
                    .shape(Shape.createRect(x1, z1, x2, z2), (float) (p.has("y") ? p.get("y").getAsDouble() + 0.2 : 70))
                    .lineColor(color(kind, 1f)).fillColor(color(kind, 0.22f)).lineWidth(2).depthTestEnabled(false).build());
            }
            for (JsonElement e : spec.has("points") ? spec.getAsJsonArray("points") : new JsonArray()) {
                JsonObject p = e.getAsJsonObject();
                next.put("point-" + str(p, "id"), POIMarker.builder().label(str(p, "label")).detail(esc(str(p, "detail")))
                    .position(p.get("x").getAsDouble(), p.get("y").getAsDouble(), p.get("z").getAsDouble()).build());
            }
            places.getMarkers().clear();
            places.getMarkers().putAll(next);
        }
        if (spec.has("resources")) {
            Map<String, Marker> next = new HashMap<>();
            for (JsonElement e : spec.getAsJsonArray("resources")) {
                JsonObject p = e.getAsJsonObject();
                next.put("res-" + str(p, "id"), POIMarker.builder().label(str(p, "label")).detail(esc(str(p, "detail")))
                    .position(p.get("x").getAsDouble(), p.get("y").getAsDouble(), p.get("z").getAsDouble()).maxDistance(600).build());
            }
            resources.getMarkers().clear();
            resources.getMarkers().putAll(next);
        }
    }

    private static String str(JsonObject o, String key) {
        JsonElement v = o.get(key);
        return v == null || v.isJsonNull() ? "" : v.getAsString();
    }
}
