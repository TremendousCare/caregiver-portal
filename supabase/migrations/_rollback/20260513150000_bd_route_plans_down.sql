-- Rollback for 20260513150000_bd_route_plans.sql
--
-- Drops the bd_route_plans table (cascading clears the trigger,
-- policies, and indexes). The frontend reads bd_route_plans via the
-- RouteBuilder screen and the Today screen's plan card — revert the
-- Vercel deploy that introduced those screens before applying this
-- rollback or both screens will error.

DROP TABLE IF EXISTS bd_route_plans;
