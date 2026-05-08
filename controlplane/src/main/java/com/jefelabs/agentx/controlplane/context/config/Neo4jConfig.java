package com.jefelabs.agentx.controlplane.context.config;

import jakarta.annotation.PreDestroy;
import org.neo4j.driver.AuthTokens;
import org.neo4j.driver.Driver;
import org.neo4j.driver.GraphDatabase;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Neo4j Driver bean for the context module. Driver creation is lazy —
 * GraphDatabase.driver() doesn't open a TCP connection; sessions are
 * acquired on first {@code session()} call. So Phase 4.1 boots fine
 * even when neo4j compose isn't running; only Phase 4.2's query
 * exercises the connection.
 *
 * <p>Connection details come from {@code agentx.neo4j.*} in
 * {@code application.yml}, defaulting to the compose service.
 */
@Configuration
public class Neo4jConfig {

    private static final Logger log = LoggerFactory.getLogger(Neo4jConfig.class);

    private final String uri;
    private final String user;
    private final String password;

    public Neo4jConfig(
        @Value("${agentx.neo4j.uri:bolt://localhost:7687}") String uri,
        @Value("${agentx.neo4j.user:neo4j}") String user,
        @Value("${agentx.neo4j.password:controlplane}") String password
    ) {
        this.uri = uri;
        this.user = user;
        this.password = password;
    }

    @Bean(destroyMethod = "close")
    public Driver neo4jDriver() {
        log.info("Configuring Neo4j driver for {} (lazy connection)", uri);
        return GraphDatabase.driver(uri, AuthTokens.basic(user, password));
    }

    @PreDestroy
    void shutdown() {
        log.info("Neo4j driver shutdown via destroy hook");
    }
}
