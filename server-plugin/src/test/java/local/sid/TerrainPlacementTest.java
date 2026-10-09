package local.sid;
public final class TerrainPlacementTest {
 public static void main(String[] args){
  check(TerrainPlacement.reclaim("builder",true,"WATER","DIRT",false));
  check(TerrainPlacement.reclaim("builder",true,"WATER","COBBLESTONE",false));
  check(!TerrainPlacement.reclaim("builder",false,"WATER","DIRT",false));
  check(!TerrainPlacement.reclaim("farmer",true,"WATER","DIRT",false));
  check(!TerrainPlacement.reclaim("builder",true,"WATER","DIRT",true));
  check(!TerrainPlacement.reclaim("builder",true,"LAVA","DIRT",false));
  check(!TerrainPlacement.reclaim("builder",true,"CHEST","DIRT",false));
  check(!TerrainPlacement.reclaim("builder",true,"WATER","IRON_BARS",false));
  System.out.println("TerrainPlacement: 8 checks passed");
 }
 private static void check(boolean value){if(!value)throw new AssertionError();}
}
