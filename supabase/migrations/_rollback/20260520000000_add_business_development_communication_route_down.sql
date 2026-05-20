-- Rollback: remove the business_development communication route.
--
-- Safe because the up migration was the only thing that created the row,
-- and any JWT created against it via set_route_ringcentral_jwt() would
-- have been cleared first by an admin running clear_route_ringcentral_jwt
-- (which is the normal pre-delete sequence used by the Admin Settings UI).
--
-- If a vault secret named 'ringcentral_jwt_business_development' still
-- exists at rollback time, it is left in place — DELETE on the route row
-- does not cascade to the vault. Operators should run
-- clear_route_ringcentral_jwt('business_development') before this rollback
-- if they want the JWT secret removed as well.

DELETE FROM public.communication_routes
 WHERE category = 'business_development';
