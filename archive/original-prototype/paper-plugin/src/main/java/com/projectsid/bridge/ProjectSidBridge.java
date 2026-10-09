package com.projectsid.bridge;

import org.bukkit.plugin.java.JavaPlugin;
import java.net.InetSocketAddress;
import java.nio.ByteBuffer;
import java.nio.channels.AsynchronousServerSocketChannel;
import java.nio.channels.AsynchronousSocketChannel;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import com.google.gson.Gson;

public class ProjectSidBridge extends JavaPlugin {
    private AsynchronousServerSocketChannel server;
    private final Gson gson = new Gson();
    private final ConcurrentHashMap<String, Object> worldState = new ConcurrentHashMap<>();

    @Override
    public void onEnable() {
        try {
            server = AsynchronousServerSocketChannel.open();
            server.bind(new InetSocketAddress("0.0.0.0", 25566));
            accept();
            getLogger().info("ProjectSid WebSocket bridge on 25566");
        } catch (Exception e){ e.printStackTrace(); }
    }

    private void accept(){
        server.accept(null, new java.util.concurrent.FutureCallback<AsynchronousSocketChannel>(){
            public void onCompleted(AsynchronousSocketChannel ch, Object a){ accept(); }
            public void onFailure(Throwable t){ t.printStackTrace(); }
        });
    }

    @Override
    public void onDisable(){ try { server.close(); } catch(Exception e){} }
}
