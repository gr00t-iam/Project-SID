package local.sid;

import net.kyori.adventure.text.serializer.plain.PlainTextComponentSerializer;
import org.bukkit.Bukkit;
import org.bukkit.Material;
import org.bukkit.block.Chest;
import org.bukkit.inventory.*;
import org.bukkit.inventory.meta.BookMeta;

import java.util.*;

/**
 * What the Master Chef reads from the world: every food recipe the server knows (crafting, furnace, smoker and
 * campfire - including datapack and mod recipes, since they all register with the server) and the written books
 * lying in the warehouse chests (a player can teach the chef a dish by leaving him a book).
 */
final class Kitchen {
    private Kitchen() {}

    /** Items worth knowing in a kitchen: anything edible, plus the in-between items food recipes need. */
    private static boolean culinary(Material m) {
        return m.isEdible() || Set.of(Material.CAKE, Material.SUGAR, Material.BOWL, Material.MILK_BUCKET).contains(m);
    }

    /** First material a recipe choice accepts (tags such as "any planks" become their first member). */
    private static String choice(RecipeChoice c) {
        if (c instanceof RecipeChoice.MaterialChoice mc && !mc.getChoices().isEmpty()) return mc.getChoices().getFirst().name();
        if (c instanceof RecipeChoice.ExactChoice ec && !ec.getChoices().isEmpty()) return ec.getChoices().getFirst().getType().name();
        return null;
    }

    /** Hunger points and saturation a food restores (null when the server cannot say). */
    @SuppressWarnings("UnstableApiUsage")
    private static Map<String, Object> nutrition(Material m) {
        try {
            var food = new ItemStack(m).getData(io.papermc.paper.datacomponent.DataComponentTypes.FOOD);
            if (food != null) return Map.of("nutrition", food.nutrition(), "saturation", food.saturation());
        } catch (Throwable ignored) {}
        return null;
    }

    /** Every food recipe: {result, count, heat (none|furnace|smoker|campfire), inputs {item:n}, time (ticks), nutrition}. */
    static List<Map<String, Object>> recipes() {
        List<Map<String, Object>> out = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        for (Iterator<Recipe> it = Bukkit.recipeIterator(); it.hasNext(); ) {
            Recipe r;
            try { r = it.next(); } catch (RuntimeException e) { continue; }
            if (r == null) continue;
            Material result = r.getResult().getType();
            if (!culinary(result)) continue;
            Map<String, Integer> inputs = new TreeMap<>();
            String heat = "none";
            int time = 0;
            if (r instanceof ShapedRecipe s) {
                Map<Character, RecipeChoice> choices = s.getChoiceMap();
                for (String row : s.getShape()) for (char ch : row.toCharArray()) {
                    String m = choice(choices.get(ch));
                    if (m != null) inputs.merge(m, 1, Integer::sum);
                }
            } else if (r instanceof ShapelessRecipe s) {
                for (RecipeChoice c : s.getChoiceList()) { String m = choice(c); if (m != null) inputs.merge(m, 1, Integer::sum); }
            } else if (r instanceof CookingRecipe<?> c) {
                String m = choice(c.getInputChoice());
                if (m != null) inputs.put(m, 1);
                heat = r instanceof SmokingRecipe ? "smoker" : r instanceof CampfireRecipe ? "campfire" : r instanceof FurnaceRecipe ? "furnace" : "furnace";
                time = c.getCookingTime();
            } else continue;
            if (inputs.isEmpty()) continue;
            String key = result.name() + "|" + heat + "|" + inputs;
            if (!seen.add(key)) continue;
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("result", result.name());
            entry.put("count", r.getResult().getAmount());
            entry.put("heat", heat);
            entry.put("inputs", inputs);
            entry.put("time", time);
            Map<String, Object> n = nutrition(result);
            if (n != null) entry.putAll(n);
            out.add(entry);
        }
        return out;
    }

    /** An ingredient choice as one name: any planks / any log when the recipe takes any of them, else the first option. */
    private static String anyChoice(RecipeChoice c) {
        if (c instanceof RecipeChoice.MaterialChoice mc && mc.getChoices().size() > 1) {
            List<Material> ms = mc.getChoices();
            if (ms.stream().allMatch(m -> m.name().endsWith("_PLANKS"))) return "any_PLANKS";
            if (ms.stream().allMatch(m -> m.name().matches(".*_(LOG|WOOD|STEM|HYPHAE)$"))) return "any_LOG";
        }
        return choice(c);
    }
    /**
     * Every crafting and cooking recipe the server knows (2.25.0): {result, count, how: craft|smelt, inputs}, one per
     * result and kind, paged (offset, limit) so a single reply stays small. The crafter plans from these.
     */
    static Map<String, Object> allRecipes(int offset, int limit) {
        List<Map<String, Object>> all = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        for (Iterator<Recipe> it = Bukkit.recipeIterator(); it.hasNext(); ) {
            Recipe r;
            try { r = it.next(); } catch (RuntimeException e) { continue; }
            if (r == null || r.getResult().getType().isAir()) continue;
            Map<String, Integer> inputs = new TreeMap<>();
            String how;
            if (r instanceof ShapedRecipe s) {
                how = "craft";
                Map<Character, RecipeChoice> choices = s.getChoiceMap();
                for (String row : s.getShape()) for (char ch : row.toCharArray()) { String m = anyChoice(choices.get(ch)); if (m != null) inputs.merge(m, 1, Integer::sum); }
            } else if (r instanceof ShapelessRecipe s) {
                how = "craft";
                for (RecipeChoice c : s.getChoiceList()) { String m = anyChoice(c); if (m != null) inputs.merge(m, 1, Integer::sum); }
            } else if (r instanceof FurnaceRecipe || r instanceof BlastingRecipe || r instanceof SmokingRecipe) {
                how = "smelt";
                String m = choice(((CookingRecipe<?>) r).getInputChoice()); if (m != null) inputs.put(m, 1);
            } else continue;
            if (inputs.isEmpty()) continue;
            String result = r.getResult().getType().name();
            if (!seen.add(result + "|" + how)) continue;
            Map<String, Object> e = new LinkedHashMap<>();
            e.put("result", result); e.put("count", r.getResult().getAmount()); e.put("how", how); e.put("inputs", inputs);
            all.add(e);
        }
        all.sort(Comparator.comparing(m -> (String) m.get("result")));
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("total", all.size());
        out.put("recipes", all.subList(Math.min(offset, all.size()), Math.min(all.size(), offset + limit)));
        return out;
    }

    /** Written books and book-and-quills in the given chests: {title, author, pages[]} (first 12 pages, 600 chars each). */
    static List<Map<String, Object>> books(List<? extends org.bukkit.block.Container> chests) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (org.bukkit.block.Container chest : chests) for (ItemStack i : chest.getInventory().getContents()) {
            if (i == null || !(i.getItemMeta() instanceof BookMeta meta)) continue;
            List<String> pages = new ArrayList<>();
            for (var page : meta.pages()) {
                if (pages.size() >= 12) break;
                String text = PlainTextComponentSerializer.plainText().serialize(page);
                pages.add(text.length() > 600 ? text.substring(0, 600) : text);
            }
            Map<String, Object> b = new LinkedHashMap<>();
            b.put("title", meta.hasTitle() ? PlainTextComponentSerializer.plainText().serialize(meta.title()) : "Untitled");
            b.put("author", meta.hasAuthor() ? PlainTextComponentSerializer.plainText().serialize(meta.author()) : "");
            b.put("pages", pages);
            b.put("chest", List.of(chest.getX(), chest.getY(), chest.getZ()));
            out.add(b);
            if (out.size() >= 20) return out;
        }
        return out;
    }
}
