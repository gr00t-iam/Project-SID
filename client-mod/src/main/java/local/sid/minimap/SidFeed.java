package local.sid.minimap;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.*;

/**
 * Project SID citizens for the map: polls the dashboard on the LAN (/api/state for positions, /api/minds for who is
 * thinking) in the background. Never blocks the game; when the dashboard is unreachable the list simply stays empty.
 */
final class SidFeed {
    record Citizen(String id, String name, double x, double y, double z, boolean thinking, String doing) {}

    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2)).build();
    private volatile List<Citizen> citizens = List.of();
    private volatile Set<String> thinking = Set.of();
    private long last;
    private boolean busy;

    List<Citizen> citizens() { return citizens; }

    void tick(String baseUrl, int everyMs) {
        if (baseUrl == null || baseUrl.isBlank() || busy || System.currentTimeMillis() - last < everyMs) return;
        busy = true; last = System.currentTimeMillis();
        String base = baseUrl.endsWith("/") ? baseUrl.substring(0, baseUrl.length() - 1) : baseUrl;
        get(base + "/api/minds").thenAccept(body -> {
            Set<String> t = new HashSet<>();
            try { for (JsonElement e : JsonParser.parseString(body).getAsJsonObject().getAsJsonArray("thinkingNow")) t.add(e.getAsString()); } catch (RuntimeException ignored) {}
            thinking = t;
        }).exceptionally(e -> null);
        get(base + "/api/state").thenAccept(body -> {
            List<Citizen> out = new ArrayList<>();
            try {
                for (JsonElement e : JsonParser.parseString(body).getAsJsonObject().getAsJsonArray("agents")) {
                    JsonObject a = e.getAsJsonObject();
                    if (!a.has("x") || a.get("x").isJsonNull() || (a.has("online") && !a.get("online").getAsBoolean())) continue;
                    String id = a.get("id").getAsString();
                    String name = a.has("name") ? a.get("name").getAsString().replaceAll("\"[^\"]*\"\\s*", "").split(" the ")[0].trim() : id;
                    String doing = a.has("tag") && !a.get("tag").isJsonNull() ? a.get("tag").getAsString().replaceAll("§.", "") : "";
                    out.add(new Citizen(id, name, a.get("x").getAsDouble(), a.get("y").getAsDouble(), a.get("z").getAsDouble(), thinking.contains(id), doing));
                }
            } catch (RuntimeException ignored) {}
            citizens = out;
        }).whenComplete((v, e) -> busy = false);
    }
    private java.util.concurrent.CompletableFuture<String> get(String url) {
        return http.sendAsync(HttpRequest.newBuilder(URI.create(url)).timeout(Duration.ofSeconds(3)).GET().build(), HttpResponse.BodyHandlers.ofString())
            .thenApply(r -> r.statusCode() == 200 ? r.body() : "{}");
    }
}
